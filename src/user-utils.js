const {
  allowedRoles: roles,
  statuses,
  mutationTypes,
  mutationDirections,
} = require('./config');

const USER_COLUMNS =
  'id, username, email, phone, password_hash, role, balance, status, api_key, created_at, updated_at';
const PUBLIC_USER_COLUMNS =
  'id, username, email, phone, role, balance, status, created_at, updated_at';

function serializeUser(user) {
  if (!user) return null;
  const {
    password_hash: _passwordHash,
    api_key: _apiKey,
    ...safeUser
  } = user;
  return safeUser;
}

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizePhone(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidUsername(value) {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(value);
}

function isValidEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value) {
  return value.length >= 7 && value.length <= 20 && /^[+0-9()\-\s]+$/.test(value);
}

function validateUserFields({ username, email, phone, password }) {
  const errors = {};
  if (!username || !isValidUsername(username)) {
    errors.username =
      'username must be 3-32 chars and contain only letters, numbers, dot, underscore, or hyphen';
  }
  if (!email || !isValidEmail(email)) errors.email = 'email is invalid';
  if (!phone || !isValidPhone(phone)) errors.phone = 'phone is invalid';
  if (password !== undefined &&
      (typeof password !== 'string' || password.length < 8 || password.length > 128)) {
    errors.password = 'password must be 8-128 characters';
  }
  return errors;
}

function parsePositiveInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parsePagination(query) {
  const page = Math.max(1, Math.min(1000000, Number.parseInt(query.page || '1', 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit || '20', 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

function assertOneOf(value, values, field) {
  return typeof value === 'string' && values.includes(value)
    ? null
    : `${field} must be one of: ${values.join(', ')}`;
}

module.exports = {
  USER_COLUMNS,
  PUBLIC_USER_COLUMNS,
  serializeUser,
  normalizeUsername,
  normalizeEmail,
  normalizePhone,
  isValidUsername,
  isValidEmail,
  isValidPhone,
  validateUserFields,
  parsePositiveInteger,
  parsePagination,
  assertOneOf,
  roles,
  statuses,
  mutationTypes,
  mutationDirections,
};
