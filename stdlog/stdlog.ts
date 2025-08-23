// index.ts
import { spawn } from "child_process";
import * as fs from "fs/promises";
import path from "path";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(
      "Usage: bun run index.ts <program> [args_for_program...]",
    );
    console.log("Example: bun run index.ts ls -l");
    console.log("Example: bun run index.ts node -e \"console.log('\\x1b[31mHello Red!\\x1b[0m')\"");
    return;
  }

  const programToRun = args[0];
  const programArgs = args.slice(1);
  const outputFileName = `${path.basename(programToRun)}-output.txt`;

  console.log(`Launching program: ${programToRun} ${programArgs.join(" ")}`);
  console.log(`Saving output to: ${outputFileName}`);

  let stdoutBuffer = "";
  let stderrBuffer = "";

  try {
    const childProcess = spawn(programToRun, programArgs, {
      shell: true, // Use shell to ensure commands like 'ls' or 'node' are found
    });

    childProcess.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      process.stdout.write(data); // Also log to current terminal
    });

    childProcess.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      process.stderr.write(data); // Also log to current terminal
    });

    childProcess.on("close", async (code) => {
      console.log(`\nProgram exited with code: ${code}`);

      if (stdoutBuffer.length > 0) {
        try {
          await fs.writeFile(outputFileName, stdoutBuffer);
          console.log(
            `STDOUT successfully saved to ${outputFileName}`,
          );
        } catch (err) {
          console.error(
            `Error writing STDOUT to file ${outputFileName}:`,
            err,
          );
        }
      } else {
        console.log("No STDOUT to save.");
      }

      if (stderrBuffer.length > 0) {
        const errorFileName = `${path.basename(programToRun)}-error.txt`;
        try {
          await fs.writeFile(errorFileName, stderrBuffer);
          console.log(
            `STDERR also saved to ${errorFileName} (if any)`,
          );
        } catch (err) {
          console.error(
            `Error writing STDERR to file ${errorFileName}:`,
            err,
          );
        }
      }
    });

    childProcess.on("error", (err) => {
      console.error(`Failed to start program '${programToRun}':`, err);
    });
  } catch (error) {
    console.error("An unexpected error occurred:", error);
  }
}

main();