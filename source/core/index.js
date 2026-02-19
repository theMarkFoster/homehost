//=====================
//== Logging prelude
//=====================
const fs = require('fs');
global.logger = {};

const STATUS_WIDTH = 10; // inside the brackets
let currentTask = "";

function centerText(text, width) {
  const totalPadding = Math.max(0, width - text.length);
  const left = Math.floor(totalPadding / 2);
  const right = totalPadding - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

function formatStatus(label, colorCode) {
  const centered = centerText(label, STATUS_WIDTH);
  return `\x1b[${colorCode}m[${centered}]\x1b[0m`;
}

logger.bootLog = (task) => {
  currentTask = task;
  // show a placeholder "pending" status while running
  process.stdout.write(`[${" ".repeat(STATUS_WIDTH)}] ${task}`);
};

function finalize(label, colorCode) {
  // go back to start of the line and rewrite it with status + original message
  process.stdout.write("\r");
  process.stdout.clearLine(0);
  process.stdout.write(`${formatStatus(label, colorCode)} ${currentTask}\n`);
  currentTask = "";
}

logger.ok = () => finalize("OK", "1;32");
logger.fail = () => finalize("FAIL", "1;31");



console.log('Boot file located and node environment active. Beginning program build.');
const path = require('path');

//=====================
//== Global/Core Reference Table
//== 
//== Loads global table "homehost" with paths to core libraries
//== for use in addon packages
//=====================

try{
	global.homehost = {};
	homehost.config = {}
	homehost.app = path.join(__dirname, 'app', 'init.js');
	homehost.users = path.join(__dirname, 'user-management', 'init.js');
	homehost.data = path.join(__dirname, '..', '..', 'data' );
}
catch(err){
	logger.fail();
	throw err;
}

//=====================
//== Global/Core Boot
//=====================

console.log('[BOOT] Initializing core components');
try{

	logger.bootLog( '\tScanning and setting up data directory' );
	if(!fs.existsSync(homehost.data)) { homehost.setup = true; fs.mkDir(homehost.data) }
	logger.ok()

  logger.bootLog( '\tLoading config.json into memory' );
  homehost.config = require( path.join( homehost.data, 'config.json' ) );
  logger.ok();
  
  logger.bootLog( '\tLoading express app into memory and initializing CORS-policy'); 
	require(homehost.app);
	logger.ok();
	
	logger.bootLog( '\tLoading user management module and wiring authentication routes');
	require(homehost.users);
	logger.ok();
	
}catch(err){
	logger.fail();
	throw err;
}
