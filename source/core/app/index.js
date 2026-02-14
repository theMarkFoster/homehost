//=================
//== Express (main 'app' initialization)
//=================
const express = require('express');
const app = express();

//==================
//== HTTPS/SSL/Reverse-Proxy Implementation
//==================

//Trust configured reverse-proxy IPs and defer encryption. If none are configured, allow all
//and hope the client is shielding the host from direct connections appropriately.
if(homehost.config.Proxies.length > 0) app.set('trust proxy', homehost.config.Proxies);
else app.set('trust proxy', true)


//=================
//== Cross Site Origin Resource Restrictions (cors.js wiring)
//=================
const path = require('path');
const corsPolicy = require( path.join(__dirname, 'cors.js') );
app.use(corsPolicy);

//Returns express app variable prepared with CORS restriction, reverse proxy configuration for ssl,
//and 
module.exports = app;