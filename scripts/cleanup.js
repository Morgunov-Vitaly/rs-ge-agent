const { runRetentionCleanup } = require('../infrastructure/retention-manager');

const dryRun = process.argv.includes('--dry-run');

runRetentionCleanup({ dryRun })
    .then((result) => {
        console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
        console.error(`Retention cleanup failed: ${error.message}`);
        process.exitCode = 1;
    });
