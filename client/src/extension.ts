/* eslint-disable @typescript-eslint/no-var-requires */
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from "path";
import * as vscode from "vscode";
import {
	commands,
	ExtensionContext,
	Position,
	Range,
	Selection,
	TextEdit,
	TextEditor,
	TextEditorEdit,
	window,
	workspace,
} from "vscode";

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
} from "vscode-languageclient/node";

import { runN3Execute, runN3Debug } from "./n3/n3Execute";
import { n3OutputChannel } from "./n3/n3OutputChannel";
import axios from 'axios';

let client: LanguageClient;

const BUILTINS_URL = 'https://eulersharp.sourceforge.net/2003/03swap/eye-builtins.html';
const outputChannel = vscode.window.createOutputChannel('Built-in Functions');

async function fetchBuiltIns(): Promise<Map<string, Set<string>>> {
    try {
        const response = await axios.get(BUILTINS_URL);
        const data = response.data as string;

        console.log("Data fetched successfully");
        console.log("Raw Data Response:", data); // To see the raw HTML

        const builtIns = new Map<string, Set<string>>();

        //const regex = /([a-z]+):([a-zA-Z-]+) a e:Builtin\./g;
        //console.log("Regex pattern:", regex.toString());

		// Extract the prefixes and their URLs
        const prefixRegex = /<span class="keyword">@prefix<\/span> (\w+): <a class="uri" href="[^"]+">[^<]+<\/a>\./g;
        const functionRegex = /<a class="qname" href="[^"]+">(\w+):(\w+)<\/a> <span class="keyword">a<\/span> <a class="qname" href="[^"]+">e:Builtin<\/a>\./g;
        


        let match;
        let matchCount = 0;
        while ((match = functionRegex.exec(data)) !== null) { 
            const prefix = match[1]; 
            const func = match[2]; 
            console.log(`Match ${++matchCount} - Prefix: ${prefix}, Function: ${func}`); 
             
            if (!builtIns.has(prefix)) { 
                builtIns.set(prefix, new Set()); 
            } 
            builtIns.get(prefix)!.add(func); 
        } 
 
        // After processing all matches 
        console.log(`Total matches found: ${matchCount}`); 
        logBuiltIns(builtIns); 
 
        return builtIns; 
    } catch (error) { 
        vscode.window.showErrorMessage(`Error fetching built-ins: ${error.message}`); 
        console.error(`Error fetching built-ins: ${error.message}`); 
        return new Map(); 
    } 
}

function logBuiltIns(builtIns: Map<string, Set<string>>) {
    console.log("Logging parsed built-ins:");
    builtIns.forEach((funcs, prefix) => {
        console.log(`Prefix: ${prefix}`);
        funcs.forEach(func => {
            console.log(`  Function: ${func}`);
        });
    });
}

async function checkFunctionInPrefix(prefix: string, func: string): Promise<boolean> {
    const builtIns = await fetchBuiltIns();
    console.log(`Checking function "${func}" in prefix "${prefix}": `, builtIns.get(prefix));  // Debug message
    if (builtIns.has(prefix)) {
        const exists = builtIns.get(prefix)!.has(func);
        if (exists) {
            return true;
        } else {
            vscode.window.showInformationMessage(`The function "${func}" does not exist in the prefix "${prefix}".`);
        }
    } else {
        vscode.window.showInformationMessage(`No functions found for prefix "${prefix}".`);
    }
    return false;
}

export async function activate(context: ExtensionContext) {
    n3OutputChannel.show();
	
	// Fetch built-ins and log them
    const builtIns = await fetchBuiltIns();
    logBuiltIns(builtIns);

    // - LSP client
    const serverModule = context.asAbsolutePath(
        path.join("server", "out", "server.js")
    );
    const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions,
        },
    };

    const serverConfig: object = getServerConfig(context);

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: "file", language: "n3" }],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher("**/.clientrc"),
        },
        initializationOptions: serverConfig,
    };

    client = new LanguageClient(
        "N3languageServer",
        "N3 Language Server",
        serverOptions,
        clientOptions
    );

    client.start();

    context.subscriptions.push(
        commands.registerCommand("n3.execute", async () => {
            await runN3Execute(context);
        })
    );

    context.subscriptions.push(
        commands.registerCommand("n3.debug", async () => {
            await runN3Debug(context);
        })
    );

    const traceInsert = new TraceInsert();
    context.subscriptions.push(
        commands.registerTextEditorCommand(
            "n3.addTrace",
            async (editor: TextEditor, edit: TextEditorEdit) =>
                editor.selections.forEach((selection, i) =>
                    traceInsert.insert(editor, edit, selection)
                )
        )
    );

    workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("n3LspServer")) {
            const serverConfig = getServerConfig(context);
            client.sendNotification("update/config", serverConfig);
        }
    });

    client.onReady().then(() => {
        client.onNotification("update/namespaces", (edits: InsertNamespace[]) => {
            const editor = vscode.window.activeTextEditor;
            edits.forEach((edit) => {
                const txtEdit = edit.edit;
                editor.edit((editBuilder) => {
                    editBuilder.insert(txtEdit.range.start, txtEdit.newText);
                });
                window.showInformationMessage(`Inserted namespace: "${edit.ns.prefix}" (you can turn this off under settings)`);
            });
        });
    });

    // Register the new command for checking functions
    context.subscriptions.push(
        vscode.commands.registerCommand('n3Checker.checkFunction', async () => {
            const prefix = await vscode.window.showInputBox({ prompt: 'Enter the prefix' });
            const func = await vscode.window.showInputBox({ prompt: 'Enter the function name' });

            if (prefix && func) {
                const exists = await checkFunctionInPrefix(prefix, func);
                if (exists) {
                    vscode.window.showInformationMessage(`The function "${func}" exists in the prefix "${prefix}".`);
                } else {
                    vscode.window.showInformationMessage(`The function "${func}" does not exist in the prefix "${prefix}".`);
                }
            } else {
                vscode.window.showWarningMessage('Prefix and function name are required.');
            }
        })
    );
}

function getServerConfig(context: ExtensionContext): object {
	const config = workspace.getConfiguration("n3LspServer");

	const serverConfig = {
		ns: { map: undefined, mode: undefined },
		ac: { enabled: undefined, vocabTermMap: undefined },
	};

	const configNsPath = config.get<string>("namespacesFile");
	const nsMapPath = configNsPath
		? configNsPath
		: context.asAbsolutePath("data/namespaces.json");
	const nsMode = config.get<string>("insertNamespaces");
	try {
		serverConfig.ns.map = require(nsMapPath);
		serverConfig.ns.mode = nsMode;
	} catch (e) {
		window.showErrorMessage(
			`error loading namespaces file ${configNsPath}: ${e}`
		);
	}

	const configAc = config.get<boolean>("autocomplete");
	serverConfig.ac.enabled = configAc;

	if (configAc) {
		const configAcWithVocabs = config.get<boolean>(
			"autocompleteWithWellKnownVocabularies"
		);

		if (configAcWithVocabs) {
			let vocabFileMapPath = config.get<string>("vocabulariesFile");
			if (!vocabFileMapPath)
				vocabFileMapPath = context.asAbsolutePath("data/vocab/vocabularies.json");

			const rootPath = vocabFileMapPath.substring(0, vocabFileMapPath.lastIndexOf("/"));

			let path: string;
			try {
				const vocabFileMap = require(vocabFileMapPath);
				const vocabTermMap = {};
				for (const key in vocabFileMap) {
					const file: string = vocabFileMap[key];
					path = `${rootPath}/${file}`;
					vocabTermMap[key] = require(path);
				}

				serverConfig.ac.vocabTermMap = vocabTermMap;

			} catch (e) {
				window.showErrorMessage(
					`Error loading vocabulary terms file ${path}:\n${e}`
				);
			}
		}
	}

	return serverConfig;
}

interface InsertNamespace {
	ns: NsInfo;
	edit: TextEdit;
}

interface NsInfo {
	prefix: string,
	uri: string
}

class TraceInsert {
	prefix = "T";
	cnt = 0;

	insert(editor: TextEditor, edit: TextEditorEdit, selection: Selection): void {
		let text = `"${this.prefix + this.cnt++}" log:trace (  ) .`;
		const pos = selection.active;

		let priorNewline = false;
		let priorEndChar = "";
		let nextNewline = false;
		let indent = "";

		if (pos.character > 0) {
			const wsRange = editor.document.getWordRangeAtPosition(
				new Position(pos.line, 0),
				/\s+/
			);

			if (!(wsRange !== undefined && wsRange.end.character >= pos.character)) {
				priorNewline = true;

				const line = editor.document.lineAt(pos.line).text;
				if (!line.trim().endsWith(".")) {
					if (!line.substring(0, pos.character).trim().endsWith("{"))
						priorEndChar = (line.endsWith(" ") ? "" : " ") + ".";
				}
			}
		}

		const nextChar = editor.document.getText(
			new Range(new Position(pos.line, pos.character + 1), pos)
		);
		if (nextChar != "") {
			nextNewline = true;
		}

		if ((priorNewline || nextNewline) && pos.line > 0) {
			const range = editor.document.getWordRangeAtPosition(
				new Position(pos.line, 0),
				/\s+/
			);

			if (range !== undefined) {
				if (!nextNewline || range.end.character == pos.character) {
					const numSpaces = range.end.character - range.start.character;
					indent = new Array(numSpaces + 1).join(" ");
				}
			}
		}

		text =
			(priorNewline ? priorEndChar + "\n" + indent : "") +
			text +
			(nextNewline ? "\n" + indent : "");

		edit.insert(pos, text);
	}
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
