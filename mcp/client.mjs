if (process.argv[2] === '--configure') {
  try {
    const { configureClient } = await import('./setup.mjs');
    await configureClient(process.argv[1], process.argv[3]);
  } catch (error) {
    process.stderr.write(`Phonebase setup: ${error.message}\n`);
    process.exitCode = 1;
  }
} else {
  await import('./server.ts');
}
