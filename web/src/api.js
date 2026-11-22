const base = '/api';

async function request(path, options = {}) {
  const response = await fetch(base + path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    const message = (payload && payload.error) || response.statusText || 'Request failed';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const api = {
  health: () => request('/health'),
  mibs: () => request('/mibs'),
  table: (name) => request(`/mibs/tables/${encodeURIComponent(name)}`),
  fixtures: () => request('/demo/fixtures'),
  controls: () => request('/demo/controls'),
  updateControls: (patch) => request('/demo/controls', { method: 'PUT', body: JSON.stringify(patch) }),
  resetDemo: () => request('/demo/reset', { method: 'POST' }),
  collect: (body) => request('/collect', { method: 'POST', body: JSON.stringify(body) }),
  runs: () => request('/runs'),
  run: (id) => request(`/runs/${id}`),
  deleteRun: (id) => request(`/runs/${id}`, { method: 'DELETE' }),
  exportCsvUrl: (id) => `${base}/runs/${id}/export.csv`,
  exportJsonUrl: (id) => `${base}/runs/${id}/export.json`,
};
