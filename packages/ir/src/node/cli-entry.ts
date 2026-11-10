import { runCli } from './cli';

runCli(process.argv.slice(2), text => { process.stdout.write(text); })
  .then(code => { process.exitCode = code; })
  .catch((error: unknown) => {
    console.error('Unexpected validator failure:', error);
    process.exitCode = 2;
  });
