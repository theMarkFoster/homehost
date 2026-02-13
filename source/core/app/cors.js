//Pull array of allowed origins from config
const allowedOrigins = homehost.config.Domains

//Initialize cors policy that only allows http behavior from servers/specified-origins
const cors = require('cors');
const corsPolicy = cors({
  origin: function (origin, callback) {

    //Allow CURL/Server requests at top level (no origin)
    if (!origin) return callback(null, true)

    //Only do clean callback 
    if (allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true
});

//Export policy for use in main app setup
module.exports = corsPolicy;