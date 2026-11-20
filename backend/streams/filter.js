// Quicknode Streams filter for Allowance: Arc native USDC movements that touch the agent wallet.
// Dataset: logs. Network: Arc Testnet. Rendered to filter.js by `npm run streams:filter`; paste that file.
//
// Arc emits every native USDC movement as an ERC-20 Transfer log from the system emitter
// 0xffff...fffe (18 decimals). The ERC-20 interface 0x3600...0000 mirrors SOME of them (6 decimals);
// indexing both double-counts, so only the native emitter is kept (Quicknode "Index every Arc USDC
// movement with Streams" guide; Arc "EVM differences" docs). Verified on Arc Testnet: our deposit and
// faucet transactions each carry both logs.
const NATIVE_USDC_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CHAIN_ID = '5042002';
const WATCHED = ["0xe5edec99dcf041e022e7a843d00b37fb49d08fbd"]; // lowercase addresses
const FILTER_VERSION = 'allowance-1';
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

// stream.data nests logs differently across datasets and batch sizes: Logs gives arrays of logs,
// Receipts / Block-with-receipts give receipts carrying a `logs` array. Collect anything log-shaped.
function collectLogs(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectLogs(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.address === 'string' && Array.isArray(value.topics) && typeof value.data === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value.logs)) collectLogs(value.logs, out);
  if (Array.isArray(value.receipts)) collectLogs(value.receipts, out);
}

function hexToDecimal(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try {
    return BigInt(value).toString(10);
  } catch (e) {
    return null;
  }
}

function topicToAddress(topic) {
  return typeof topic === 'string' && BYTES32.test(topic) ? '0x' + topic.slice(-40).toLowerCase() : null;
}

function normalize(log) {
  if (log.removed === true) return null;
  if (log.address.toLowerCase() !== NATIVE_USDC_EMITTER) return null;
  if (log.topics.length !== 3 || String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  const from = topicToAddress(log.topics[1]);
  const to = topicToAddress(log.topics[2]);
  if (!from || !to) return null;
  if (WATCHED.indexOf(from) === -1 && WATCHED.indexOf(to) === -1) return null;
  const amountRaw = BYTES32.test(log.data) ? hexToDecimal(log.data) : null;
  const blockNumber = hexToDecimal(log.blockNumber);
  const logIndex = hexToDecimal(log.logIndex);
  if (amountRaw === null || blockNumber === null || logIndex === null) return null;
  if (typeof log.transactionHash !== 'string' || !BYTES32.test(log.transactionHash)) return null;
  const tx = log.transactionHash.toLowerCase();
  return {
    canonical_id: CHAIN_ID + ':' + tx + ':' + logIndex,
    chain_id: CHAIN_ID,
    block_number: blockNumber,
    transaction_hash: tx,
    log_index: logIndex,
    from_address: from,
    to_address: to,
    amount_raw: amountRaw,
    decimals: 18,
    block_timestamp: hexToDecimal(log.blockTimestamp),
  };
}

function main(stream) {
  const logs = [];
  collectLogs((stream && stream.data) || [], logs);
  const movements = [];
  for (const log of logs) {
    const m = normalize(log);
    if (m) movements.push(m);
  }
  if (!movements.length) return null; // nothing delivered for quiet ranges
  const meta = (stream && stream.metadata) || {};
  return {
    filter_version: FILTER_VERSION,
    network: meta.network || null,
    batch_start_range: meta.batch_start_range === undefined ? null : meta.batch_start_range,
    batch_end_range: meta.batch_end_range === undefined ? null : meta.batch_end_range,
    movements: movements,
  };
}
