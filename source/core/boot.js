//=====================
//== Logging prelude
//=====================

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

logger.bootLog('Loading core library path references to global')
try{
	global.homehost = {};
	homehost.config = require( path.join("..", "..", "data", "config.json") );
	homehost.app = path.join(__dirname, 'app');
	homehost.users = path.join(__dirname, 'user-management');
}
catch(err){
	logger.fail();
	console.error(err);
}
logger.ok();

//=====================
//== Global/Core Boot
//=====================

logger.bootLog('Running core library setup');
try{
	require(homehost.app);
	require(homehost.users);
}catch(err){
	logger.fail();
	console.error(err);
}
logger.ok();
