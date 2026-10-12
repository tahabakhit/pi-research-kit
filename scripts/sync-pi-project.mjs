#!/usr/bin/env node
// Retired: domain work tracking uses a private, explicit enrollment registry.
// Deliberately performs no API calls and cannot recreate prefix-based enrollment.
console.error("The pi* importer is retired. Use the domain work-tracking runner and explicit registry.");
process.exitCode = 1;
