/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-case-declarations */
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	CodeAction,
	CodeActionKind,
	DocumentFormattingParams,
	TextEdit,
} from "vscode-languageserver/node";


import { TextDocument } from "vscode-languageserver-textdocument";

const n3 = require("./parser/n3Main_nodrop.js");

// (ac)
import { DocTokens } from "./ac/DocTokens.js";
import axios, { AxiosError } from 'axios';


// import * as should from 'should';
// import { spawnSync } from "child_process";
// import { format, join, resolve } from 'path';
// import { PythonShell } from 'python-shell';
// import { resourceLimits } from 'worker_threads';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

// - server globals

const MSG_UNKNOWN_PREFIX = "Unknown prefix: ";

let nsMode: NsModes; // configured prefix->ns map
let knownNsMap = new Map<string, string>();
// (ac)
let acEnabled = false;
let vocabTermMap = new Map<string, string[]>(); // configured ns->terms map
// (not strictly needed, but makes things easier)
const acPrefix = new Set<string>(); // prefixes added to acTokens based on vocabTermMap
let curInAc = false; // whether an ac was just issued (hack)
const acTokens = new DocTokens(); // current ac tokens

// ... needed
let curTextDocument: TextDocument;

// - server initialization

connection.onInitialize((params: InitializeParams) => {
	const config: ServerConfig = params.initializationOptions;
	setupServer(config);

	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			// completionProvider: {
			// 	resolveProvider: true
			// },
			codeActionProvider: true,
			documentFormattingProvider: true,
			completionProvider: {
				triggerCharacters: ["<", "?", ":"],
			},
		},
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true,
			},
		};
	}
	return result;
});

connection.onInitialized(() => {
	// if (hasConfigurationCapability) {
	// 	// Register for all configuration changes.
	// 	connection.client.register(
	// 		DidChangeConfigurationNotification.type,
	// 		undefined
	// 	);
	// }
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders((_event) => {
			connection.console.log("Workspace folder change event received.");
		});
	}
});

connection.onNotification("update/config", (config) => {
	connection.console.log("Config change event received.");
	setupServer(config);

	documents.all().forEach(validateTextDocument);
});


// - server configuration

interface ServerConfig {
	ns: NsOptions;
	ac: AcOptions;
}

interface NsOptions {
	map: object;
	mode: string;
}

enum NsModes {
	Automatic = "Automatic",
	Suggest = "Suggest",
}

interface AcOptions {
	enabled: boolean;
	vocabTermMap: Map<string, string[]>;
}

function setupServer(config: ServerConfig) {
	// connection.console.log("config: " + JSON.stringify(config, null, 4));

	const ns = config.ns;
	const ac = config.ac;

	nsMode = <NsModes>ns.mode;
	knownNsMap = new Map(Object.entries(ns.map));
	vocabTermMap.clear();
	acPrefix.clear();
	curInAc = false;
	acTokens.clear();

	// (ac)
	acEnabled = ac.enabled;
	if (ac.enabled) {
		if (ac.vocabTermMap) {
			vocabTermMap = new Map(Object.entries(ac.vocabTermMap));
			// (one way to print map contents..)
			// connection.console.log("vocabTermMap:" + JSON.stringify(Object.fromEntries(vocabTermMap)));
		}
	}
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
let globalSettings: any;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<any>> = new Map();

// connection.onDidChangeConfiguration((change) => {
// 	connection.console.log("onDidChangeConfiguration:" + JSON.stringify(change, null, 4));
// 	if (hasConfigurationCapability) {
// 		// Reset all cached document settings
// 		documentSettings.clear();
// 	} else {
// 		globalSettings = <any>change.settings.n3LspServer;
// 	}
	
// 	// Revalidate all open text documents
// 	documents.all().forEach(validateTextDocument);
// });

function getDocumentSettings(resource: string): Thenable<any> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: "n3LspServer",
		});
		documentSettings.set(resource, result);
	}
	return result;
}

const BUILTINS_URL = 'https://eulersharp.sourceforge.net/2003/03swap/eye-builtins.html';

async function fetchBuiltIns(): Promise<Map<string, Set<string>>> {
    try {
        const response = await axios.get(BUILTINS_URL);
        const data = response.data as string;

        //console.log("Data fetched successfully");
        //console.log("Raw Data Response:", data); // To see the raw HTML

        const builtIns = new Map<string, Set<string>>();

        const functionRegex = /<a class="qname" href="[^"]+">(\w+):(\w+)<\/a> <span class="keyword">a<\/span> <a class="qname" href="[^"]+">e:Builtin<\/a>\./g;

        let match;
        let matchCount = 0;
        while ((match = functionRegex.exec(data)) !== null) {
            const prefix = match[1];
            const func = match[2];
            //console.log(`Match ${++matchCount} - Prefix: ${prefix}, Function: ${func}`);

            if (!builtIns.has(prefix)) {
                builtIns.set(prefix, new Set());
            }
            builtIns.get(prefix)!.add(func);
        }

        // After processing all matches
        //console.log(`Total matches found: ${matchCount}`);
        //logBuiltIns(builtIns);

        return builtIns;
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error fetching built-ins: ${error.message}`);
        } else {
            console.error('Unknown error fetching built-ins');
        }
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
    //console.log(`Checking function "${func}" in prefix "${prefix}": `, builtIns.get(prefix));  // Debug message
    if (builtIns.has(prefix)) {
        const exists = builtIns.get(prefix)!.has(func);
        if (exists) {
            return true;
        } else {
            console.log(`The function "${func}" does not exist in the prefix "${prefix}".`);
        }
    } else {
        console.log(`No functions found for prefix "${prefix}".`);
    }
    return false;
}


async function fetchAndExtractParameters(url: string): Promise<{ xsdValues: string[], fnoTypes: string[], subjectTypes: string[], objectTypes: string[] }> {
    const xsdValues: Set<string> = new Set();
    const fnoTypes: Set<string> = new Set();
	const subjectTypes: Set<string> = new Set();
    const objectTypes: Set<string> = new Set();

    try {
        const response = await axios.get(url);
		let rdfData = response.data;

        // Extract JSON data from the script tag
        const jsonRegex = /<script type="application\/json" data-target="react-app\.embeddedData">({.*?})<\/script>/;
        const jsonMatch = rdfData.match(jsonRegex);

        if (jsonMatch) {
            const jsonData = JSON.parse(jsonMatch[1]);
            rdfData = jsonData?.payload?.blob?.rawLines?.join('\n');
            if (rdfData) {
                // Replace shortcut `=>` with `log:implies` and `<=` with `log:impliedBy`
                rdfData = rdfData.replace(/=>/g, 'log:implies').replace(/<=/g, 'log:impliedBy');

                const parameterRegex = /\[\s*a\s*fno:Parameter\s*;([\s\S]*?)\s*\]/g;
                let parameterMatch;

                while ((parameterMatch = parameterRegex.exec(rdfData)) !== null) {
					const parameterBlock = parameterMatch[0];
				
					// Check if the parameter is subject or object
					const positionRegex = /fnon:position\s+fnon:(\w+)/;
					const positionMatch = positionRegex.exec(parameterBlock);
					const isSubject = positionMatch && positionMatch[1] === 'subject';
					const isObject = positionMatch && positionMatch[1] === 'object';
				
					// Capture fno:type for either subject or object
					const typeRegex = /fno:type\s+([\s\S]*?)(?:;|\])/g;
					let typeMatch;
					while ((typeMatch = typeRegex.exec(parameterBlock)) !== null) {
						const typeContent = typeMatch[1].trim();
				
						// Add fno:type globally
						fnoTypes.add(typeContent);
				
						// Handle subject types explicitly
						if (isSubject) {
							subjectTypes.add(typeContent);  // Add any type (log:Uri, rdf:List, etc.) for the subject
				
							// Check for XSD-specific types within the subject type
							const typeXsdRegex = /xsd:[\w-]+/g;
							let typeXsdMatch;
							while ((typeXsdMatch = typeXsdRegex.exec(typeContent)) !== null) {
								xsdValues.add(typeXsdMatch[0]);
								subjectTypes.add(typeXsdMatch[0]);  // Add any XSD types to the subject
							}
						}
				
						// Handle object types explicitly
						if (isObject) {
							objectTypes.add(typeContent);  // Add any type (xsd:string, rdf:List, etc.) for the object
				
							// Check for XSD-specific types within the object type
							const typeXsdRegex = /xsd:[\w-]+/g;
							let typeXsdMatch;
							while ((typeXsdMatch = typeXsdRegex.exec(typeContent)) !== null) {
								xsdValues.add(typeXsdMatch[0]);
								objectTypes.add(typeXsdMatch[0]);  // Add any XSD types to the object
							}
						}
					}
				
					// Capture owl:unionOf content for both subject and object types
					const unionOfRegex = /owl:unionOf\s*\(([\s\S]*?)\)/;
					const unionOfMatch = unionOfRegex.exec(parameterBlock);
					if (unionOfMatch) {
						const unionOfContent = unionOfMatch[1];
				
						// Extract XSD types from unionOf for subject or object
						const unionOfXsdRegex = /xsd:[\w-]+/g;
						let unionOfXsdMatch;
						while ((unionOfXsdMatch = unionOfXsdRegex.exec(unionOfContent)) !== null) {
							xsdValues.add(unionOfXsdMatch[0]);
				
							if (isSubject) {
								subjectTypes.add(unionOfXsdMatch[0]);
							} else if (isObject) {
								objectTypes.add(unionOfXsdMatch[0]);
							}
						}
					}
				}

                //console.log('Extracted fno:type values:', Array.from(fnoTypes));
                //console.log('Extracted xsd values:', Array.from(xsdValues));
                //console.log('Extracted subject types:', Array.from(subjectTypes));
                //console.log('Extracted object types:', Array.from(objectTypes));
            } else {
                console.log('No RDF data found in the JSON payload.');
            }
        } else {
            console.log('No JSON block found in the HTML.');
        }
    } catch (error) {
        console.error('Error fetching RDF data:', error);
    }

    return { 
        xsdValues: Array.from(xsdValues), 
        fnoTypes: Array.from(fnoTypes), 
        subjectTypes: Array.from(subjectTypes), 
        objectTypes: Array.from(objectTypes) 
    };
}



// Function to determine if the error is an Axios error
function isAxiosError(error: unknown): error is AxiosError {
    return (error as AxiosError).isAxiosError !== undefined;
}

async function generateAndLaunchURL(prefix: string, func: string): Promise<void> {
    // Generate the path based on the prefix and func
    const path = `${prefix}/${func}.n3`;

    // Construct the full URL
    const url = `https://github.com/w3c-cg/n3Builtins/blob/main/spec/src/${path}`;

    // Log the URL
    console.log(`Launching URL: ${url}`);

    try {
        // Perform a HEAD request to check if the URL exists
        await axios.head(url);

        // If the HEAD request is successful, proceed to fetch and extract parameters
        await fetchAndExtractParameters(url);
    } catch (error) {
        if (isAxiosError(error)) {  // Type guard for Axios error
            if (error.response && error.response.status === 404) {
                console.error('Error: The URL does not exist (404 Not Found)');
            } else {
                console.error('Error: Unable to reach the URL or another issue occurred', error.message);
            }
        } else {
            console.error('An unknown error occurred', error);
        }
    }
}
// connection.onDidChangeWatchedFiles(_change => {
// 	// Monitored files have change in VSCode
// 	connection.console.log('We received an file change event');
// });

// Only keep settings for open documents
documents.onDidClose((e) => {
	documentSettings.delete(e.document.uri);
});

// - parse n3 document
// (includes syntax validation, updating AC tokens)

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	const docUri = textDocument.uri;

	curTextDocument = textDocument;
	const text = textDocument.getText();

	const diagnostics: Diagnostic[] = [];
	const edits: InsertNamespace[] = [];

	acTokens.reset(docUri);
	acPrefix.clear();

	let hasSyntaxError = false;  // Syntax error flag

	n3.parse(text, {
		syntaxError: function (
			recognizer: any,
			offendingSymbol: any,
			line: any,
			column: any,
			msg: string,
			err: any
		) {
			connection.console.log(
				`syntaxError: ${offendingSymbol}-${line}-${column}-${msg}-${err}`
			);

			const start = { line: line, character: column };
			const end = start;

			const diagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Error,
				range: {
					start: start,
					end: end,
				},
				message: msg,
				source: "n3",
			};

			diagnostics.push(diagnostic);
			hasSyntaxError = true;  // Set the flag when a syntax error occurs
		},

		unknownPrefix: function (
			prefix: string,
			pName: string,
			line: number,
			start: number,
			end: number
		) {
			connection.console.log(
				`unknownPrefix:${prefix}-${pName}-${line}-${start}-${end}`
			);

			if (nsMode == NsModes.Automatic && knownNsMap.has(prefix)) {
				const uri = knownNsMap.get(prefix)!;
				edits.push(getInsertNamespace(curTextDocument, prefix, uri));
			} else {
				line = line - 1;
				const startPos = { line: line, character: start };
				const endPos = { line: line, character: start + prefix.length };

				const msg = MSG_UNKNOWN_PREFIX + prefix;
				const diagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Error,
					range: {
						start: startPos,
						end: endPos,
					},
					message: msg,
					source: "n3",
					data: textDocument,
				};
				diagnostics.push(diagnostic);
			}
		},

		consoleError: function (
			type: string,
			line: string,
			start: string,
			end: string,
			msg: string
		) {
			connection.console.log(
				`consoleError: ${type}-${line}-${start}-${end}-${msg}`
			);
		},

		onTerm: function (type: string, term: any, ctx: any) {
			acTokens.add(docUri, type, term);
		},

		onTriple: function (ctx: any) {
			function ctx_text(ctx: any) {
				return text.substring(ctx.start.start, ctx.stop.stop + 1);
			}
		
			function term_prod(ctx: any): any {
				if (ctx.children && ctx.children.length > 0 && ctx.children[0].ruleIndex) {
					return term_prod(ctx.children[0]);
				} else {
					return ctx ? ctx.ruleIndex + 1 : "unknown";
				}
			}
		
			function infer_data_type(value: string): string {
				// Recognize different data types
				if (value.match(/^\(\s*\{.*\}\s*\)$/s)) return "listOfFormulas"; // Recognize lists of formulas
				if (value.match(/^\{.*\}$/s)) return "formula"; // Recognize individual formulas
				if (value.match(/^\(.*\)$/)) return "list"; // Recognize lists
				if (value.match(/^-?\d+(\.\d+)?$/)) return "float"; // Recognize floats
				if (value.match(/^".*"$/)) return "string"; // Recognize strings
				if (value.startsWith(":")) return "function"; // Recognize functions
				if (value.startsWith("?")) return "variable"; // Recognize variables
				if (value.startsWith("<") && value.endsWith(">")) return "uri"; // Recognize URIs
				return "unknown";
			}
		
			// Function to infer types of items in a list, including handling nested structures for depth 1
			function infer_list_item_types(listValue: string): string[] {
				// Match nested lists, formulas, or individual items
				const items = listValue
					.slice(1, -1) // Remove outer parentheses
					.match(/\(\s*\{.*?\}\s*\)|\{.*?\}|\(.*?\)|\S+/g); // Match nested formulas, lists, or plain items

				// For each item, recursively infer its type
				return items ? items.map(infer_data_type) : [];
			}
		
			// NEW: Check whether the types of items in a list match the expected types.
			function validate_variable_types(types: string[], expectedTypes: Set<string>): boolean {
				for (const type of types) {
					if (type === "variable") continue;  // Allow variables without complaints
					if (!expectedTypes.has(type)) return false;  // Type does not match expected types
				}
				return true;
			}
		
			// Ensure that ctx and its children are defined
			if (!ctx || !ctx.children || ctx.children.length < 2) {
				connection.console.log("Invalid context or missing elements in triple.");
				return;
			}
		
			const subject: any = ctx.children[0];
			const predicateObjectList: any = ctx.children[1];
		
			// Check if predicateObjectList has the required children
			if (!predicateObjectList.children || predicateObjectList.children.length < 2) {
				connection.console.log("Invalid predicate-object list in triple.");
				return;
			}
		
			const verb = predicateObjectList.children[0];
			const objectList = predicateObjectList.children[1];
		
			// Check if objectList has at least one child
			if (!objectList.children || objectList.children.length === 0) {
				connection.console.log("Invalid object list in triple.");
				return;
			}
		
			const object = objectList.children[0];
		
			const subjectText = ctx_text(subject);
			const subjectType = infer_data_type(subjectText);

			const objectText = ctx_text(object);
			const objectType = infer_data_type(objectText);
		
			let output = `subject: ${subjectText} (rule: ${term_prod(subject)}, type: ${subjectType})\n` +
				`verb (first): ${ctx_text(verb)} (rule: ${term_prod(verb)})\n` +
				`object (first): ${ctx_text(object)} (rule: ${term_prod(object)}, type: ${objectType})`;
			let subjectListItemTypes: string[] = [];
			let objectListItemTypes: string[] = [];  // Separate array for object list item types
				
			// Check and infer subject list item types
			if (subjectType === "list" || subjectType === "listOfFormulas") {
				subjectListItemTypes = infer_list_item_types(subjectText);
				output += `\nSubject list item types: ${subjectListItemTypes.join(", ")}`;
			}
				
			// Check and infer object list item types
			if (objectType === "list" || objectType === "listOfFormulas") {
				objectListItemTypes = infer_list_item_types(objectText);
				output += `\nObject list item types: ${objectListItemTypes.join(", ")}`;
			}
				
			connection.console.log(output);
		
			const verbText = ctx_text(verb);
			// Handle special cases for '=>' and '<='
			if (verbText === '=>' || verbText === '<=') {
				const correspondingFunction = verbText === '=>' ? 'log:implies' : 'log:impliedBy';
				connection.console.log(`The verb "${verbText}" is recognized as a shorthand for "${correspondingFunction}".`);
				// Handle the logic as needed for these cases, no need for prefix validation
			} else if (!verbText.includes(':')) {
				connection.console.log("Invalid verb format; missing prefix and function.");
				return;
			}
		
			const [prefix, func] = verbText.split(':');
		
			if (subjectText && verbText && objectText) {
				checkFunctionInPrefix(prefix, func).then(functionExists => {
					if (functionExists) {
						connection.console.log(`The function "${func}" exists in the prefix "${prefix}".`);
		
						generateAndLaunchURL(prefix, func).then(async () => {
							if (!hasSyntaxError) {  // Only compare types if no syntax error occurred
								const { fnoTypes, xsdValues, subjectTypes, objectTypes } = await fetchAndExtractParameters(`https://github.com/w3c-cg/n3Builtins/blob/main/spec/src/${prefix}/${func}.n3`);
		
								const typeMapping: Record<string, string> = {
									"rdf:List": "list",  // Treats rdf:List as a list
									"xsd:float": "float",
									"xsd:string": "string",
									"rdf:Function": "function",
									"log:Formula": "listOfFormulas",  // Maps log:Formula to listOfFormulas
									"log:Uri": "uri"  // URI mapping
									
								};
		
								// Subject type matching test
								let subjectTypeMatched = false;
								for (const fnoType of subjectTypes) {
									// Check if either rdf:List or log:Formula is expected and allow for both list and listOfFormulas types
									if (typeMapping[fnoType] === subjectType || 
										(fnoType === "rdf:List" && subjectType === "listOfFormulas") || 
										(fnoType === "log:Formula" && subjectType === "list")) {
										connection.console.log(`The subject type ${subjectType} and fno:type "${fnoType}" match.`);
										subjectTypeMatched = true;
										break;
									}
								}
								if (!subjectTypeMatched) {
									for (const fnoType of subjectTypes) {
										connection.console.log(`The subject type "${subjectType}" and fno:type "${fnoType}" do not match.`);
									}
								}
								
								// Check if the subject is a list, then validate each item type
								if (subjectType === "list" || subjectType === "listOfFormulas") {
									const expectedType = subjectTypes.find(fnoType => typeMapping[fnoType] === "listOfFormulas");
								
									if (expectedType) {
										const isValid = subjectListItemTypes.every(type => type === "formula" || type === "variable");
								
										if (isValid) {
											connection.console.log(
												`The list item datatypes of subject "${subjectText}" (list item types: ${subjectListItemTypes.join(", ")}) ` +
												`are valid for the expected type log:Formula.`
											);
										} else {
											connection.console.log(
												`The list item datatypes of subject "${subjectText}" (list item types: ${subjectListItemTypes.join(", ")}) ` +
												`are not valid for the expected type log:Formula.`
											);
										}
									} else if (xsdValues.length > 0) {
										const xsdTypeSet = new Set<string>(xsdValues.map((type: string) => typeMapping[type]));
										const isValid = validate_variable_types(subjectListItemTypes, xsdTypeSet);
		
										if (isValid) {
											connection.console.log(
												`The list item datatypes of subject (list item types: ${subjectListItemTypes.join(", ")}) ` +
												`exist in the extracted xsd:type values (${xsdValues.join(", ")}).`
											);
										} else {
											connection.console.log(
												`The list item datatypes of subject "${subjectText}" (list item types: ${subjectListItemTypes.join(", ")}) ` +
												`do not match the expected xsd:type values (${xsdValues.join(", ")}).`
											);
										}
									}
								}

								// Object type matching test
								let objectTypeMatched = false;
								for (const fnoType of objectTypes) {
									// Same logic for object: Allow rdf:List to match with listOfFormulas and vice versa
									if (typeMapping[fnoType] === objectType || 
										(fnoType === "rdf:List" && objectType === "listOfFormulas") || 
										(fnoType === "log:Formula" && objectType === "list")) {
										connection.console.log(`The object type ${objectType} and fno:type "${fnoType}" match.`);
										objectTypeMatched = true;
										break;
									}
								}
								
								if (!objectTypeMatched) {
									for (const fnoType of objectTypes) {
										connection.console.log(`The object type "${objectType}" and fno:type "${fnoType}" do not match.`);
									}
								}
								
		
								// Check if the object is a list, then validate each item type
								if (objectType === "list" || objectType === "listOfFormulas") {
									const expectedType = objectTypes.find(fnoType => typeMapping[fnoType] === "listOfFormulas");
								
									if (expectedType) {
										const isValid = objectListItemTypes.every(type => type === "formula" || type === "variable");
								
										if (isValid) {
											connection.console.log(
												`The list item datatypes of object "${objectText}" (list item types: ${objectListItemTypes.join(", ")}) ` +
												`are valid for the expected type log:Formula.`
											);
										} else {
											connection.console.log(
												`The list item datatypes of object "${objectText}" (list item types: ${objectListItemTypes.join(", ")}) ` +
												`are not valid for the expected type log:Formula.`
											);
										}
									} else if (xsdValues.length > 0) {
										const xsdTypeSet = new Set<string>(xsdValues.map((type: string) => typeMapping[type]));
										const isValid = validate_variable_types(objectListItemTypes, xsdTypeSet);
		
										if (isValid) {
											connection.console.log(
												`The list item datatypes of object (list item types: ${objectListItemTypes.join(", ")}) ` +
												`exist in the extracted xsd:type values (${xsdValues.join(", ")}).`
											);
										} else {
											connection.console.log(
												`The list item datatypes of object "${objectText}" (list item types: ${objectListItemTypes.join(", ")}) ` +
												`do not match the expected xsd:type values (${xsdValues.join(", ")}).`
											);
										}
									}
								}
							} else {
								connection.console.log("Skipping type comparison due to syntax error.");
							}
						});
					} else {
						connection.console.log(`The function "${func}" does not exist in the prefix "${prefix}".`);
					}
				});
			} else {
				connection.console.log("The input is not a valid triple.");
			}
		},											
				
						

		onPrefix: function (prefix: string, uri: string) {
			prefix = String(prefix);
			prefix = prefix.substring(0, prefix.length - 1); // remove ":"

			// connection.console.log("onPrefix? " + prefix + ", " + uri);
			if (vocabTermMap.size > 0 && !acPrefix?.has(prefix)) {
				uri = String(uri);
				uri = uri.substring(1, uri.length - 1); // remove "<" and ">"

				// (ac) prefix is found for a known vocabulary:
				// add vocabulary's terms to acTokens under this prefix
				// (also see onCompletion)
				if (vocabTermMap.has(uri)) {
					const terms: string[] = vocabTermMap.get(uri)!;
					terms.forEach((t) => acTokens.add(docUri, "pname", [prefix, t]));

					acPrefix?.add(prefix); // record that prefix was added to ac-tokens
				}
			}
		},

		// newAstLine: function(line:string) {
		// 	connection.console.log("ast" + line);
		// }
	});

	// connection.console.log("diagnostics?\n" + JSON.stringify(diagnostics, null, 4));
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
	// (ac) updating the editor contents will mess with ac (it somehow "cancels" the ac-list)
	// if ac'ing, only issue ns updates once no syntax errors are found (i.e., stmt is done)
	if (!curInAc || (diagnostics.length == 0 && edits.length > 0)) { 
		connection.sendNotification("update/namespaces", edits); 
		curInAc = false;
	}
}

// - import namespaces

connection.onCodeAction((params) => {
	// connection.console.log("params? " + JSON.stringify(params, null, 4));
	const diagnostics = params.context.diagnostics;

	// connection.console.log("diagns? " + JSON.stringify(diagnostics, null, 4));
	const codeActions: CodeAction[] = [];
	for (const diagnostic of diagnostics) {
		if (diagnostic.message.startsWith(MSG_UNKNOWN_PREFIX)) {
			const prefix: string = diagnostic.message.substring(
				MSG_UNKNOWN_PREFIX.length
			);
			// connection.console.log("prefix: " + prefix);

			if (knownNsMap.has(prefix)) {
				const uri = knownNsMap.get(prefix)!;
				const edit = getInsertNamespace(curTextDocument, prefix, uri);

				const codeAction: CodeAction = {
					title: `Import ${prefix} namespace`,
					kind: CodeActionKind.QuickFix,
					diagnostics: [diagnostic],
					edit: {
						changes: {
							[params.textDocument.uri]: [edit.edit],
						},
					},
				};

				codeActions.push(codeAction);
			}
		}
	}
	// connection.console.log("codeActions? " + JSON.stringify(codeActions, null, 4));
	return codeActions;
});


interface InsertNamespace {
	ns: NsInfo;
	edit: TextEdit;
}

interface NsInfo {
	prefix: string,
	uri: string
}

function getInsertNamespace(
	textDocument: TextDocument,
	prefix: string,
	uri: string
): InsertNamespace {
	// keep any commented lines at the top
	// (could be annotations such as @alsoload)
	// also, add extra newline if next is not prefix

	const pos = getStmtPos(textDocument.getText());

	let directive = `@prefix ${prefix}: <${uri}> .\n`;
	if (!pos.nextIsPrefix) directive += "\n";

	return {
		ns: { prefix: prefix, uri: uri },
		edit: {
			range: {
				start: { line: pos.lineNr, character: 0 },
				end: { line: pos.lineNr, character: 0 },
			},
			newText: directive,
		},
	};
}

interface StmtPos {
	lineNr: number;
	nextIsPrefix: boolean;
}

function getStmtPos(text: string): StmtPos {
	let lineCnt = -1,
		startIdx: number,
		endIdx = -1,
		curLine: string;
	do {
		startIdx = endIdx + 1;
		endIdx = text.indexOf("\n", startIdx);
		if (endIdx == -1) return { lineNr: 0, nextIsPrefix: false };

		curLine = text.substring(startIdx, endIdx).trim();

		lineCnt++;
	} while (curLine.startsWith("#"));

	// skip newlines that come after as well
	while (curLine.trim() == "") {
		startIdx = endIdx + 1;
		endIdx = text.indexOf("\n", startIdx);
		curLine = text.substring(startIdx, endIdx).trim();

		lineCnt++;
	}

	// whether next line is also prefix
	const nextIsPrefix = curLine.trim().startsWith("@prefix");

	return {
		lineNr: lineCnt,
		nextIsPrefix: nextIsPrefix,
	};
}

// - format n3 document

connection.onDocumentFormatting(formatDocument);

async function formatDocument(
	params: DocumentFormattingParams
): Promise<TextEdit[]> {
	const doc = documents.get(params.textDocument.uri)!;
	const settings = await getDocumentSettings(params.textDocument.uri);

	const text: string = doc.getText();
	const formatted: string | undefined = await formatCode(text, settings);

	if (formatted) {
		// connection.console.log("formatted? " + formatted);
		const edit: TextEdit = {
			range: {
				start: { line: 0, character: 0 },
				end: { line: doc.lineCount, character: 0 },
			},
			newText: formatted,
		};

		// connection.console.log("edit?\n" + JSON.stringify(edit, null, 4));
		return [edit];
	} else return [];
}

async function formatCode(text: string, settings: any) {
	const formatNs = settings["formatNamespaces"];
	return n3.format(text, {
		tab: 4,
		graphOnNewline: true,
		formatNamespaces: formatNs,
	});
}

// (ac) auto-completion of terms
connection.onCompletion(
	(params: TextDocumentPositionParams): CompletionItem[] => {
		if (!acEnabled) return [];

		connection.console.log("onCompletion");

		const docUri = params.textDocument.uri;
		// connection.console.log("uri? " + uri);

		const doc = documents.get(docUri)!;

		const symbol = doc.getText({
			start: params.position,
			end: {
				line: params.position.line,
				character: params.position.character - 1,
			},
		});
		// connection.console.log("symbol? " + symbol);

		let type: string,
			local = false,
			prefix = '';
		switch (symbol) {
			case "?":
				type = "qvar";
				local = true;
				break;
			case "<":
				type = "iri";
				break;
			case ":":
				let expanded = doc.getText({
					start: { line: params.position.line, character: 0 },
					end: params.position,
				});
				expanded = expanded.substring(expanded.lastIndexOf(" ") + 1);
				// connection.console.log("expanded? " + expanded);
				if (expanded == "_:") {
					type = "bnode";
					local = true;
				} else {
					type = "pname";
					// get all localnames under the "needle" prefix
					// (vscode will take care of auto-completion for any returned strings)
					prefix = expanded.substring(0, expanded.length - 1);
				}
				break;
			default:
				return [];
		}

		// (ac) in case we're typing a new prefix with ac-tokens
		// (new: i.e., not yet handled in onPrefix)
		// let's add those tokens here directly
		if (prefix != '' && knownNsMap.has(prefix) && !acPrefix.has(prefix)) {
			const uri = knownNsMap.get(prefix)!;

			if (vocabTermMap.has(uri)) {
				const terms: string[] = vocabTermMap.get(uri)!;
				terms.forEach((t) =>
					acTokens.add(docUri, "pname", [prefix, t])
				);

				curInAc = true;
				acPrefix.add(prefix); // record that prefix was added to ac-tokens
			}
		}

		let results: string[];
		if (local) results = acTokens.get(docUri, type, prefix);
		else results = acTokens.getAll(type, prefix);

		connection.console.log("ac? " + prefix + " - " + results);

		return results.map((str) => CompletionItem.create(str));
	}
);

// // This handler resolves additional information for the item selected in
// // the completion list.
// connection.onCompletionResolve(
// 	(item: CompletionItem): CompletionItem => {
// 		if (item.data === 1) {
// 			item.detail = 'TypeScript details';
// 			item.documentation = 'TypeScript documentation';
// 		} else if (item.data === 2) {
// 			item.detail = 'JavaScript details';
// 			item.documentation = 'JavaScript documentation';
// 		}
// 		return item;
// 	}
// );

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
