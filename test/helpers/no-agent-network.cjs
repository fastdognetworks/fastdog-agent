// Any attempted connection is fatal, even when the application catches the error.
require('node:net').Socket.prototype.connect = function () {
  process.stderr.write('UNEXPECTED_AGENT_NETWORK\n');
  process.exit(91);
};
global.fetch = async function () {
  process.stderr.write('UNEXPECTED_AGENT_FETCH\n');
  process.exit(92);
};
