pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract GameFiEcoFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatch();
    error InvalidParameter();
    error ReplayDetected();
    error StateMismatch();
    error DecryptionFailed();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, uint256 encryptedDataCount);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] results);

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    struct Batch {
        bool isOpen;
        uint256 totalEncryptedTax;
        uint256 totalEncryptedResourceGeneration;
        uint256 submissionCount;
    }

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(uint256 => euint32) public encryptedTaxData;
    mapping(uint256 => euint32) public encryptedResourceGenerationData;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkCooldown(address _address, uint256 _lastTime) {
        if (block.timestamp < _lastTime + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default cooldown: 60 seconds
    }

    function addProvider(address _provider) external onlyOwner {
        isProvider[_provider] = true;
        emit ProviderAdded(_provider);
    }

    function removeProvider(address _provider) external onlyOwner {
        isProvider[_provider] = false;
        emit ProviderRemoved(_provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidParameter();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSet(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batches[currentBatchId].isOpen = true;
        batches[currentBatchId].totalEncryptedTax = 0;
        batches[currentBatchId].totalEncryptedResourceGeneration = 0;
        batches[currentBatchId].submissionCount = 0;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batches[currentBatchId].isOpen) revert InvalidBatch();
        batches[currentBatchId].isOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitData(
        euint32 _encryptedTax,
        euint32 _encryptedResourceGeneration
    ) external onlyProvider whenNotPaused checkCooldown(msg.sender, lastSubmissionTime[msg.sender]) {
        if (!batches[currentBatchId].isOpen) revert InvalidBatch();

        _initIfNeeded(_encryptedTax);
        _initIfNeeded(_encryptedResourceGeneration);

        uint256 dataIdx = batches[currentBatchId].submissionCount;
        encryptedTaxData[dataIdx] = _encryptedTax;
        encryptedResourceGenerationData[dataIdx] = _encryptedResourceGeneration;

        batches[currentBatchId].totalEncryptedTax = FHE.add(
            batches[currentBatchId].totalEncryptedTax.asEuint32(),
            _encryptedTax
        ).toUint32();

        batches[currentBatchId].totalEncryptedResourceGeneration = FHE.add(
            batches[currentBatchId].totalEncryptedResourceGeneration.asEuint32(),
            _encryptedResourceGeneration
        ).toUint32();
        
        batches[currentBatchId].submissionCount++;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DataSubmitted(msg.sender, currentBatchId, batches[currentBatchId].submissionCount);
    }

    function requestBatchDecryption() external onlyOwner whenNotPaused checkCooldown(msg.sender, lastDecryptionRequestTime[msg.sender]) {
        if (batches[currentBatchId].isOpen) revert InvalidBatch(); // Batch must be closed

        euint32 memory totalEncryptedTax = batches[currentBatchId].totalEncryptedTax.asEuint32();
        euint32 memory totalEncryptedResourceGeneration = batches[currentBatchId].totalEncryptedResourceGeneration.asEuint32();

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalEncryptedTax);
        cts[1] = FHE.toBytes32(totalEncryptedResourceGeneration);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        uint256 batchId = decryptionContexts[requestId].batchId;

        euint32 memory totalEncryptedTax = batches[batchId].totalEncryptedTax.asEuint32();
        euint32 memory totalEncryptedResourceGeneration = batches[batchId].totalEncryptedResourceGeneration.asEuint32();

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalEncryptedTax);
        cts[1] = FHE.toBytes32(totalEncryptedResourceGeneration);

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert DecryptionFailed();
        }

        uint256[] memory results = new uint256[](2);
        assembly {
            results[0] := mload(add(cleartexts, 0x20))
            results[1] := mload(add(cleartexts, 0x40))
        }

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, results);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 _val) internal pure {
        if (!FHE.isInitialized(_val)) {
            revert("FHE: value not initialized");
        }
    }

    function _requireInitialized(euint32 _val) internal pure {
        if (!FHE.isInitialized(_val)) {
            revert("FHE: value not initialized");
        }
    }
}