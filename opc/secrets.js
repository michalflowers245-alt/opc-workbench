export function secret(name) {
  const configured = process.env[name];
  return typeof configured === 'string' ? configured.trim() : '';
}

export function secretStatus(name) {
  return Boolean(secret(name));
}

const SECRET_PATTERN = /(key|secret|token|authorization|password|cookie)/i;

export function redact(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_PATTERN.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return result;
  }
  if (typeof value === 'string' && value.length > 2000) return value.slice(0, 2000) + '…';
  return value;
}

export function missing(names) {
  return names.filter(name => !secret(name));
}
