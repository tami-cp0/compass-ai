// Side-effect module: load .env before anything else reads process.env. Import
// this FIRST in the entrypoint so config modules (which validate env at import
// time) see the values. Previously dotenv was loaded inside the Redis module;
// with that gone, this is the single explicit load point.
import * as dotenv from 'dotenv';

dotenv.config();
