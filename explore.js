// Quick explorer: node explore.js <endpoint> [arg]
// Examples:
//   node explore.js missions
//   node explore.js planet 16377
//   node explore.js research

const { devClient } = require('./client');
const { api } = devClient();
const [,, cmd, arg] = process.argv;

async function main() {
  if (!cmd || !(cmd in api)) {
    console.log('Available endpoints:\n ', Object.keys(api).join('\n  '));
    return;
  }
  const data = await api[cmd](arg);
  console.log(JSON.stringify(data, null, 2));
}

main().catch(e => {
  if (e.response) console.error(`HTTP ${e.response.status}:`, e.response.data);
  else console.error(e.message);
});
