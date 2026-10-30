// Loaded only in agent subprocesses; fixtures retain their loopback listeners.
require('node:net').Server.prototype.listen = function () {
  throw new Error('The outbound agent must not open a listening socket');
};
