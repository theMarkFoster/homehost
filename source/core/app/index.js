//Library prelude
const path = require('path');
const express = require('express');
const corsPolicy = require( path.join(__dirname, 'cors.js') );

//Create global app object and CORS-policy
const app = express();
app.use(corsPolicy);

module.exports = app;