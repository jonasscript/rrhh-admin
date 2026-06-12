const { v4: uuidv4 } = require('uuid');

/**
 * Generates a new RFC-4122 v4 UUID string (36 chars).
 * Use this before every INSERT that requires a primary key.
 */
const newId = () => uuidv4();

module.exports = { newId };
