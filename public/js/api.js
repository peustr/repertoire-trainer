// Thin wrappers around the local REST API.

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  list: () => call('GET', '/api/repertoires'),
  get: (id) => call('GET', `/api/repertoires/${id}`),
  create: (rep) => call('POST', '/api/repertoires', rep),
  update: (id, patch) => call('PUT', `/api/repertoires/${id}`, patch),
  remove: (id) => call('DELETE', `/api/repertoires/${id}`),
  progress: (id, patch) => call('PATCH', `/api/repertoires/${id}/progress`, patch),
  resetProgress: (id) => call('DELETE', `/api/repertoires/${id}/progress`),
  settings: () => call('GET', '/api/settings'),
  saveSettings: (s) => call('PUT', '/api/settings', s),
  samples: () => call('GET', '/api/samples'),
  engine: () => call('GET', '/api/engine'),
  addPuzzles: (id, puzzles) => call('POST', `/api/repertoires/${id}/puzzles`, { puzzles }),
  deletePuzzle: (id, pid) => call('DELETE', `/api/repertoires/${id}/puzzles/${pid}`),
  deleteGap: (id, key) => call('DELETE', `/api/repertoires/${id}/gaps?key=${encodeURIComponent(key)}`),
  lichess: {
    status: () => call('GET', '/api/lichess/status'),
    connect: (token) => call('POST', '/api/lichess/token', { token }),
    disconnect: () => call('DELETE', '/api/lichess/token'),
    explorer: (fen, source = 'lichess') => call('GET', `/api/lichess/explorer?fen=${encodeURIComponent(fen)}&source=${source}`),
    study: (url) => call('GET', `/api/lichess/study?url=${encodeURIComponent(url)}`),
    studies: () => call('GET', '/api/lichess/studies'),
  },
};
