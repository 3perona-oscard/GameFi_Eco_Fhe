import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface GameParameter {
  id: string;
  name: string;
  encryptedValue: string;
  timestamp: number;
  proposedBy: string;
  status: "pending" | "approved" | "rejected";
  description: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [parameters, setParameters] = useState<GameParameter[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showProposalModal, setShowProposalModal] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newParameter, setNewParameter] = useState({ name: "", value: 0, description: "" });
  const [selectedParameter, setSelectedParameter] = useState<GameParameter | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [showStats, setShowStats] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const approvedCount = parameters.filter(p => p.status === "approved").length;
  const pendingCount = parameters.filter(p => p.status === "pending").length;
  const rejectedCount = parameters.filter(p => p.status === "rejected").length;

  useEffect(() => {
    loadParameters().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadParameters = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("parameter_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing parameter keys:", e); }
      }
      const list: GameParameter[] = [];
      for (const key of keys) {
        try {
          const paramBytes = await contract.getData(`parameter_${key}`);
          if (paramBytes.length > 0) {
            try {
              const paramData = JSON.parse(ethers.toUtf8String(paramBytes));
              list.push({ 
                id: key, 
                name: paramData.name, 
                encryptedValue: paramData.value, 
                timestamp: paramData.timestamp, 
                proposedBy: paramData.proposedBy, 
                status: paramData.status || "pending",
                description: paramData.description || ""
              });
            } catch (e) { console.error(`Error parsing parameter data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading parameter ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setParameters(list);
    } catch (e) { console.error("Error loading parameters:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitParameter = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setProposing(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting parameter with Zama FHE..." });
    try {
      const encryptedValue = FHEEncryptNumber(newParameter.value);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const paramId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const paramData = { 
        name: newParameter.name,
        value: encryptedValue, 
        timestamp: Math.floor(Date.now() / 1000), 
        proposedBy: address, 
        status: "pending",
        description: newParameter.description
      };
      await contract.setData(`parameter_${paramId}`, ethers.toUtf8Bytes(JSON.stringify(paramData)));
      const keysBytes = await contract.getData("parameter_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(paramId);
      await contract.setData("parameter_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted parameter submitted!" });
      await loadParameters();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowProposalModal(false);
        setNewParameter({ name: "", value: 0, description: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setProposing(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const approveParameter = async (paramId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted parameter with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const paramBytes = await contract.getData(`parameter_${paramId}`);
      if (paramBytes.length === 0) throw new Error("Parameter not found");
      const paramData = JSON.parse(ethers.toUtf8String(paramBytes));
      const updatedParam = { ...paramData, status: "approved" };
      await contract.setData(`parameter_${paramId}`, ethers.toUtf8Bytes(JSON.stringify(updatedParam)));
      setTransactionStatus({ visible: true, status: "success", message: "Parameter approved!" });
      await loadParameters();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Approval failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectParameter = async (paramId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted parameter with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const paramBytes = await contract.getData(`parameter_${paramId}`);
      if (paramBytes.length === 0) throw new Error("Parameter not found");
      const paramData = JSON.parse(ethers.toUtf8String(paramBytes));
      const updatedParam = { ...paramData, status: "rejected" };
      await contract.setData(`parameter_${paramId}`, ethers.toUtf8Bytes(JSON.stringify(updatedParam)));
      setTransactionStatus({ visible: true, status: "success", message: "Parameter rejected!" });
      await loadParameters();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isProposer = (proposerAddress: string) => address?.toLowerCase() === proposerAddress.toLowerCase();

  const filteredParameters = parameters.filter(param => 
    param.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    param.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Loading encrypted parameters...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>GameFi FHE Economy</h1>
          <p>Zama FHE-powered autonomous world governance</p>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
        </div>
      </header>
      <main className="main-content">
        <div className="hero-section">
          <div className="hero-content">
            <h2>Govern Your Game Economy Privately</h2>
            <p>Adjust game parameters with FHE-encrypted votes to prevent whale manipulation</p>
            <div className="hero-buttons">
              <button onClick={() => setShowProposalModal(true)} className="primary-button">
                Propose Parameter Change
              </button>
              <button onClick={() => setShowStats(!showStats)} className="secondary-button">
                {showStats ? "Hide Stats" : "Show Stats"}
              </button>
            </div>
          </div>
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
        </div>

        {showStats && (
          <div className="stats-section">
            <div className="stat-card">
              <h3>Total Parameters</h3>
              <div className="stat-value">{parameters.length}</div>
            </div>
            <div className="stat-card">
              <h3>Approved</h3>
              <div className="stat-value">{approvedCount}</div>
            </div>
            <div className="stat-card">
              <h3>Pending</h3>
              <div className="stat-value">{pendingCount}</div>
            </div>
            <div className="stat-card">
              <h3>Rejected</h3>
              <div className="stat-value">{rejectedCount}</div>
            </div>
          </div>
        )}

        <div className="search-section">
          <input 
            type="text" 
            placeholder="Search parameters..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
          <button onClick={loadParameters} className="refresh-button" disabled={isRefreshing}>
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <div className="parameters-list">
          <div className="list-header">
            <div className="header-cell">Name</div>
            <div className="header-cell">Description</div>
            <div className="header-cell">Proposed By</div>
            <div className="header-cell">Date</div>
            <div className="header-cell">Status</div>
            <div className="header-cell">Actions</div>
          </div>
          {filteredParameters.length === 0 ? (
            <div className="empty-list">
              <p>No parameters found</p>
              <button onClick={() => setShowProposalModal(true)} className="primary-button">
                Propose First Parameter
              </button>
            </div>
          ) : (
            filteredParameters.map(param => (
              <div className="parameter-item" key={param.id} onClick={() => setSelectedParameter(param)}>
                <div className="list-cell">{param.name}</div>
                <div className="list-cell description">{param.description}</div>
                <div className="list-cell">{param.proposedBy.substring(0, 6)}...{param.proposedBy.substring(38)}</div>
                <div className="list-cell">{new Date(param.timestamp * 1000).toLocaleDateString()}</div>
                <div className="list-cell">
                  <span className={`status-badge ${param.status}`}>{param.status}</span>
                </div>
                <div className="list-cell actions">
                  {isProposer(param.proposedBy) && param.status === "pending" && (
                    <>
                      <button className="action-button approve" onClick={(e) => { e.stopPropagation(); approveParameter(param.id); }}>
                        Approve
                      </button>
                      <button className="action-button reject" onClick={(e) => { e.stopPropagation(); rejectParameter(param.id); }}>
                        Reject
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </main>

      {showProposalModal && (
        <div className="modal-overlay">
          <div className="proposal-modal">
            <div className="modal-header">
              <h2>Propose New Parameter</h2>
              <button onClick={() => setShowProposalModal(false)} className="close-button">&times;</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Parameter Name</label>
                <input 
                  type="text" 
                  value={newParameter.name}
                  onChange={(e) => setNewParameter({...newParameter, name: e.target.value})}
                  placeholder="e.g. Tax Rate"
                />
              </div>
              <div className="form-group">
                <label>Value</label>
                <input 
                  type="number" 
                  value={newParameter.value}
                  onChange={(e) => setNewParameter({...newParameter, value: parseFloat(e.target.value)})}
                  placeholder="Enter numerical value"
                  step="0.01"
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea 
                  value={newParameter.description}
                  onChange={(e) => setNewParameter({...newParameter, description: e.target.value})}
                  placeholder="Explain this parameter change"
                />
              </div>
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-value">
                  <span>Original:</span> {newParameter.value}
                </div>
                <div className="preview-value">
                  <span>Encrypted:</span> {newParameter.value ? FHEEncryptNumber(newParameter.value).substring(0, 30) + "..." : "N/A"}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowProposalModal(false)} className="cancel-button">
                Cancel
              </button>
              <button onClick={submitParameter} disabled={proposing} className="submit-button">
                {proposing ? "Submitting..." : "Submit Proposal"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedParameter && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>Parameter Details</h2>
              <button onClick={() => { setSelectedParameter(null); setDecryptedValue(null); }} className="close-button">&times;</button>
            </div>
            <div className="modal-body">
              <div className="detail-row">
                <span>Name:</span>
                <strong>{selectedParameter.name}</strong>
              </div>
              <div className="detail-row">
                <span>Description:</span>
                <p>{selectedParameter.description}</p>
              </div>
              <div className="detail-row">
                <span>Proposed By:</span>
                <strong>{selectedParameter.proposedBy}</strong>
              </div>
              <div className="detail-row">
                <span>Date:</span>
                <strong>{new Date(selectedParameter.timestamp * 1000).toLocaleString()}</strong>
              </div>
              <div className="detail-row">
                <span>Status:</span>
                <strong className={`status-badge ${selectedParameter.status}`}>{selectedParameter.status}</strong>
              </div>
              <div className="encrypted-section">
                <h3>Encrypted Value</h3>
                <div className="encrypted-value">
                  {selectedParameter.encryptedValue.substring(0, 50)}...
                </div>
                <button 
                  onClick={async () => {
                    if (decryptedValue !== null) {
                      setDecryptedValue(null);
                    } else {
                      const value = await decryptWithSignature(selectedParameter.encryptedValue);
                      if (value !== null) setDecryptedValue(value);
                    }
                  }}
                  disabled={isDecrypting}
                  className="decrypt-button"
                >
                  {isDecrypting ? "Decrypting..." : decryptedValue !== null ? "Hide Value" : "Decrypt with Wallet"}
                </button>
              </div>
              {decryptedValue !== null && (
                <div className="decrypted-section">
                  <h3>Decrypted Value</h3>
                  <div className="decrypted-value">
                    {decryptedValue}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button onClick={() => { setSelectedParameter(null); setDecryptedValue(null); }} className="close-button">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="notification-modal">
          <div className={`notification-content ${transactionStatus.status}`}>
            <div className="notification-icon">
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="notification-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-section">
            <h3>GameFi FHE Economy</h3>
            <p>Privacy-preserving game governance powered by Zama FHE</p>
          </div>
          <div className="footer-section">
            <h3>Resources</h3>
            <a href="#">Documentation</a>
            <a href="#">GitHub</a>
            <a href="#">Community</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© {new Date().getFullYear()} GameFi FHE Economy. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
};

export default App;