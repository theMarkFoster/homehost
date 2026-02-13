//=====================
//== Logging prelude
//=====================

global.logger = {};

logger.bootLog = (task) => {
	process.stdout.write(`[BOOT] ${task.padEnd(50)}`);
};

logger.ok = () => {
	process.stdout.write('\033[1;32mOK\n\x1b[0m');
}

logger.fail = () => {
	process.stdout.write('\033[1;31mFAILURE\n\x1b[0m');
}


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
	homehost.config = require( path.join("..", "..", "./config.json") );
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
