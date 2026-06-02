let _pageCounter = 0;
let _requestCounter = 0;
let _connectionCounter = 0;

export function nextPageId(): string {
  _pageCounter += 1;
  return `p_${_pageCounter}`;
}

export function nextRequestId(): number {
  _requestCounter += 1;
  return _requestCounter;
}

export function nextConnectionId(): string {
  _connectionCounter += 1;
  return `c_${_connectionCounter}`;
}

export function randomSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
