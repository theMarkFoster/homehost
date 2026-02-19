//===========================
//== Discovery and setup tree
//===========================
const { createDb } = require('./db-interface.js');
const fs = require('fs');
const path = require('path');

const db = createDb( { filename: path.join( homehost.data, 'db-user-management.sqlite' )} );
db.init();

