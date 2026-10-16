'use strict';

// Manual publication only; never an implicit live-registry update or network call.
const fs = require('fs');
const path = require('path');
const { publishEmergencyCandidate } = require('../lib/emergency-updater');
const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== '--candidate' ||
  args[2] !== '--approval'
) {
  console.error(
    'Publication bloquée : fournir --candidate fichier.json --approval validation.json (empreinte et validation par service).'
  );
  process.exitCode = 1;
} else {
  try {
    publishEmergencyCandidate(
      path.join(__dirname, '../data/emergency-numbers.json'),
      JSON.parse(fs.readFileSync(args[1], 'utf8')),
      JSON.parse(fs.readFileSync(args[3], 'utf8'))
    );
    console.log('Registre publié après validation explicite.');
  } catch (error) {
    console.error('Publication bloquée :', error.message);
    process.exitCode = 1;
  }
}
