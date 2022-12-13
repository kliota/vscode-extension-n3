import { ChildProcess, spawn } from "child_process";
import { window } from "vscode";
import { n3OutputChannel } from "./n3OutputChannel";

// import $rdf = require('rdflib');
// const store = $rdf.graph()

export class Runner {

    private _process: ChildProcess | undefined;
    private _output: Array<Buffer> = [];
    private _errors: Array<Buffer> = [];

    public runN3ExecuteCommand(command: string, args: string[], n3: string, cwd?: string) {
        n3OutputChannel.clear();
        n3OutputChannel.show();

        this._process = spawn(command, args, { cwd: cwd, shell: true });

        this._process.stdin.end(n3, () => {
            //n3OutputChannel.append("file path written to stdin");
        });

        this._process.stdout.on('data', (data) => {
            this._output.push(data);
        });

        this._process.stderr.on('data', (data) => {
            this._errors.push(data);
        });

        this._process.on("exit", async (code) => {
            if (code == 1) {
                window.showErrorMessage("n3 rules failed");

                let error = Buffer.concat(this._errors).toString().split("\n").join("\n");
                n3OutputChannel.append(error);

                return;
            }

            // window.showInformationMessage("n3 rules successfully executed.");

            //turn the buffer into a list of lines and then join them back together
            let output = Buffer.concat(this._output).toString().split("\n").join("\n");
            n3OutputChannel.append(output);

            // this._output = [];
            // try {
            //     const python = spawn('python3', ['format_results.py', output])

            //     python.stdout.on('data', (data) => {
            //         this._output.push(data);
            //     });
            //     python.stderr.on('data', (code) => {
            //         //console.log(`stderr: ${code}`);
            //         // window.showInformationMessage(`child process close all stdio with code ${code}`);
            //     });
            //     python.on('close', (code) => {
            //         let formatted = Buffer.concat(this._output).toString().split("\n").join("\n");
            //         n3OutputChannel.append(formatted);
            //     });

            // } catch (e) {
            //     window.showErrorMessage("Failed serializing result to output window");
            //     console.error(e);
            // }
        });
    }
}
