'use strict';

const workflows = [
  require('./create-article'),
  require('./update-article'),
  require('./publish-article'),
  require('./create-menu-item'),
  require('./create-module'),
];

const byId = Object.fromEntries(workflows.map(w => [w.id, w]));

function list() {
  return workflows.map(({ id, name, description, icon, inputs }) => ({
    id, name, description, icon,
    inputCount: (inputs || []).length,
  }));
}

function get(id) {
  return byId[id] || null;
}

module.exports = { list, get, workflows };
