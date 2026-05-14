const { getDatabase } = require('@netlify/database');

let instance;

function getInstance() {
  if (!instance) {
    instance = getDatabase();
  }
  return instance;
}

async function db(text, params = []) {
  return getInstance().pool.query(text, params);
}

module.exports = { db };
