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

// URL to fetch EYE built-ins from
const BUILTINS_URL = 'https://eulersharp.sourceforge.net/2003/03swap/eye-builtins.html';

async function fetchBuiltIns(): Promise<Map<string, Set<string>>> {
    try {
		// Perform a GET request to fetch the raw HTML content from the built-ins URL
        const response = await axios.get(BUILTINS_URL);
        const data = response.data as string;

        // Map to store built-ins: key is the prefix (e.g., math), value is a Set of function names
		const builtIns = new Map<string, Set<string>>();

        // Regex to match built-in functions in the HTML
		const functionRegex = /<a class="qname" href="[^"]+">(\w+):(\w+)<\/a> <span class="keyword">a<\/span> <a class="qname" href="[^"]+">e:Builtin<\/a>\./g;

        let match;
        let matchCount = 0;

		// Loop through all matches found using the regex
        while ((match = functionRegex.exec(data)) !== null) {
            const prefix = match[1];
            const func = match[2];

            if (!builtIns.has(prefix)) {
                builtIns.set(prefix, new Set());
            }
			// Add the function name to the corresponding prefix's Set
            builtIns.get(prefix)!.add(func);
        }

        return builtIns; // Return the map of built-ins
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
	// Fetch the list of built-in functions and prefixes and collect them as a map
	const builtIns = await fetchBuiltIns();

	// Check whether the given prefix exists in the fetched built-in map
    if (builtIns.has(prefix)) {
		// If the prefix exists, check if the given function exists under that prefix
        const exists = builtIns.get(prefix)!.has(func);
        if (exists) {
            return true;
        }
    } else if (prefix !== "") {
        connection.console.log(`No functions found for prefix "${prefix}".`);
    }
    return false;
}

async function fetchAndExtractParameters(url: string): Promise<{ xsdValues: string[], fnoTypes: string[], subjectTypes: string[], objectTypes: string[], listElementInfo: { subjectElementCount?: number, objectElementCount?: number, subjectListElementTypes?: string[], objectListElementTypes?: string[] }[] }> {
    const xsdValues: Set<string> = new Set();
    const fnoTypes: Set<string> = new Set();
    const subjectTypes: Set<string> = new Set();
    const objectTypes: Set<string> = new Set();
    const listElementInfo: { subjectElementCount?: number, objectElementCount?: number, subjectListElementTypes?: string[], objectListElementTypes?: string[] }[] = [];

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

                const parameterRegex = /\[\s*a\s*fno:Parameter\s*;([\s\S]*)\s*\]/g;
                let parameterMatch;
                let simpleTypeMatch;

                // Step through each parameter block
                while ((parameterMatch = parameterRegex.exec(rdfData)) !== null) {
                    const parameterBlock = parameterMatch[0];

                    // Create an entry to store separate subject and object counts and types
                    const listInfo: { subjectElementCount?: number, objectElementCount?: number, subjectListElementTypes?: string[], objectListElementTypes?: string[] } = {};

                    // Check if the parameter is subject or object
                    const positionRegex = /fnon:position\s+fnon:(\w+)/;
					//const positionRegex = /fnon:position\s+fnon:(subject|object)/;
                    const positionMatch = positionRegex.exec(parameterBlock);
                    const isSubject = positionMatch && positionMatch[1] === 'subject';
                    const isObject = positionMatch && positionMatch[1] === 'object';

                    // Capture fno:type for either subject or object
                    const typeRegex = /fno:type\s+([\s\S]*?)(?:;|\])/g;
                    let typeMatch: RegExpExecArray | null;

                    // Arrays to store list element types for subject and object
                    const subjectListElementTypes: string[] = [];
                    const objectListElementTypes: string[] = [];

                    // Handle subject and object elements based on the regex matches
                    while ((typeMatch = typeRegex.exec(parameterBlock)) !== null) {
                        const typeContent = typeMatch[1].trim();

                        // Add fno:type globally
                        fnoTypes.add(typeContent);

                        // Handle subject types explicitly
                        if (isSubject) {
                            subjectTypes.add(typeContent);  // Add any type (log:Uri, rdf:List, etc.) for the subject

                            // Check for XSD-specific types within the subject type
                            const typeXsdRegex = /xsd:[\w-]+/g;
                            let typeXsdMatch: RegExpExecArray | null;
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
                            let typeXsdMatch: RegExpExecArray | null;
                            while ((typeXsdMatch = typeXsdRegex.exec(typeContent)) !== null) {
                                xsdValues.add(typeXsdMatch[0]);
                                objectTypes.add(typeXsdMatch[0]);  // Add any XSD types to the object
                            }
                        }
                    }
                    const simpleTypeRegex = /fnon:position\s+fnon:(subject|object)\s*;\s*fno:type\s+(xsd:\w+|rdf:\w+)/g;
					// Check if `listElements` or `listElementType` exist for subject or object
                    const hasListElementsOrType = /fnon:listElements|fnon:listElementType/.test(parameterBlock);

                    // Apply simpleTypeRegex only if neither `listElements` nor `listElementType` exists
                    if (!hasListElementsOrType) {
                        // Apply simple type regex to capture subject and object types separately
                        while ((simpleTypeMatch = simpleTypeRegex.exec(parameterBlock)) !== null) {
                            const position = simpleTypeMatch[1]; // 's' for subject, 'o' for object
                            const type = simpleTypeMatch[2]; // xsd:string, xsd:float, etc.

                            if (position === 'subject') {
                                subjectTypes.add(type);
								//console.log(`Added subject type: ${type}`);						
                            } else if (position === 'object') {
                                objectTypes.add(type);
								//console.log(`Added object type: ${type}`);
                            }
                        }
                    }

                    // Count the number of subject list elements
                    const subjectElementCountRegex = /fno:predicate\s+"\$s\.(\d+)"/g;
                    let match: RegExpExecArray | null;
                    let subjectElementCount = 0;
                    while ((match = subjectElementCountRegex.exec(parameterBlock)) !== null) {
                        subjectElementCount = Math.max(subjectElementCount, parseInt(match[1]));
                    }
                    if (subjectElementCount > 0) {
                        listInfo.subjectElementCount = subjectElementCount;
                    }

                    // Count the number of object list elements
                    const objectElementCountRegex = /fno:predicate\s+"\$o\.(\d+)"/g;
                    let objectElementCount = 0;
                    while ((match = objectElementCountRegex.exec(parameterBlock)) !== null) {
                        objectElementCount = Math.max(objectElementCount, parseInt(match[1]));
                    }
                    if (objectElementCount > 0) {
                        listInfo.objectElementCount = objectElementCount;
                    }

                    // Collect types of list elements for both Subject and Object
                    const monotypeListElementTypeRegex = /fnon:listElementType\s*\[\s*([\s\S]*?)fno:type\s*([\s\S]*)\s*\]\s*\]/g;
                    const subjectMultitypeListElementTypeRegex = /\$s([\s\S]*?)fnon:listElements\s*\(\s*((?:\[\s*[\s\S]*?\]\s*)+)\)([\s\S]*?)\$o/g;
                    const objectMultitypeListElementTypeRegex = /\$o([\s\S]*?)fnon:listElements\s*\(\s*((?:\[\s*[\s\S]*?\]\s*)+)\)/g;
                    const typeCaptureRegex = /fno:type\s*([\w:]+)/g;
                    const typeCaptureRegexSubject = /fno:type\s*\[\s*rdf:type\s*rdfs:Datatype\s*;\s*owl:unionOf\s*\((.*?)\)\s*\]/g;

                    // Handle monotype subject lists
                    while ((match = monotypeListElementTypeRegex.exec(parameterBlock)) !== null) {
                        if (isSubject) {
                            subjectListElementTypes.push(match[2]);
                        } else if (isObject) {
                            objectListElementTypes.push(match[2]);
                        }
                    }

                    // Handle multitype subject lists (e.g., s.1, s.2)
					while ((match = subjectMultitypeListElementTypeRegex.exec(parameterBlock)) !== null) {
						const listBlock = match[2]; // the full content of `fnon:listElements`
					
						let typeMatch: RegExpExecArray | null;
						let elementIndex = 1;
					
						// Handle owl:unionOf types if present
						if (listBlock.includes('owl:unionOf')) {
							while ((typeMatch = typeCaptureRegexSubject.exec(listBlock)) !== null) {
								const unionTypes = typeMatch[1].split(/\s+/).filter(type => type);
								subjectListElementTypes[elementIndex - 1] = unionTypes.join(", ");
								elementIndex++;
							}
						} else {							
							const typeCaptureRegex = /fno:type\s+(xsd:\w+|rdf:\w+)/g;
							let typeMatch: RegExpExecArray | null;
					
							while ((typeMatch = typeCaptureRegex.exec(listBlock)) !== null) {
								const listElementType = typeMatch[1]; // Capture the type (xsd:string, xsd:float, etc.)

								// Assign type to the matched list element ($s.1, $s.2, etc.)
								subjectListElementTypes[elementIndex - 1] = listElementType;
								elementIndex++; // Move to next element
								
							}
						}
					}

				    // Handle multitype object lists (e.g., o.1, o.2)
                    while ((match = objectMultitypeListElementTypeRegex.exec(parameterBlock)) !== null) {
                        const listBlock = match[2];
                        
                        let typeMatch: RegExpExecArray | null;
                        let elementIndex = 1;

                        while ((typeMatch = typeCaptureRegex.exec(listBlock)) !== null) {
                            objectListElementTypes[elementIndex - 1] = typeMatch[1];
                            elementIndex++;
                        }
                    }

                    // Store list element types for subject
                    if (subjectListElementTypes.length > 0) {
                        listInfo.subjectListElementTypes = subjectListElementTypes;

                    }
                    // Store list element types for object
                    if (objectListElementTypes.length > 0) {
                        listInfo.objectListElementTypes = objectListElementTypes;
                    }

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
                    // Only push if we have some information about subject or object
                    if (listInfo.subjectElementCount || listInfo.objectElementCount || listInfo.subjectListElementTypes || listInfo.objectListElementTypes) {
                        listElementInfo.push(listInfo);
                    }
                }
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
        objectTypes: Array.from(objectTypes),
        listElementInfo
    };
}


// Function to determine if the error is an Axios error
function isAxiosError(error: unknown): error is AxiosError {
    return (error as AxiosError).isAxiosError !== undefined;
}

async function generateAndLaunchURL(prefix: string, func: string): Promise<{ success: boolean, message: string }> {
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
		return { success: true, message: 'Parameters are fetched and extracted successfully' };
    } catch (error) {
        if (isAxiosError(error)) {  // Type guard for Axios error
            if (error.response && error.response.status === 404) {
                return { success: false, message: 'Error: The URL does not exist (404 Not Found)' };
            } else {
                return { success: false, message: `Error: Unable to reach the URL or another issue occurred: ${error.message}` };
            }
        } else {
            return { success: false, message: `An unknown error occurred: ${error}` };
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

	let variablesMap = new Map();  // Map for collecting declared variables' types

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
			let variableTypes: Record<string, string> = {};  // Store variable and expected types
			
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
				if (value.match(/^\(.*\)$/s)) return "list"; // Recognize lists, including nested lists
				if (value.match(/^-?\d+(\.\d+)?$/)) return "float"; // Recognize floats
				if (value.match(/^".*"$/)) return "string"; // Recognize strings
				if (value.startsWith(":")) return "function"; // Recognize functions
				if (value.startsWith("?")) return "variable"; // Recognize variables
				if (value.startsWith("<") && value.endsWith(">")) return "uri"; // Recognize URIs
				return "unknown";
			}
		
			// Recursive function to infer types of items in a list, handling nested lists and formulas of any depth
			function infer_list_item_types(listValue: string): [string[], string[]] {
				// Remove outer parentheses
				const innerValue = listValue.slice(1, -1).trim();
				const items: string[] = [];
				let currentItem = "";
				let depth = 0;
				let insideQuote = false;
			
				// Traverse the innerValue character by character
				for (let i = 0; i < innerValue.length; i++) {
					const char = innerValue[i];
			
					// Handle quoted strings
					if (char === '"' && innerValue[i - 1] !== '\\') {
						insideQuote = !insideQuote;
						currentItem += char;
						if (!insideQuote) {
							items.push(currentItem.trim());
							currentItem = "";
						}
						continue;
					}
			
					// Handle list depth
					if (char === '(') depth++;
					if (char === ')') depth--;
			
					// If we are not in a nested list or a quote, and hit a space, this is the end of an item
					if (!insideQuote && char === ' ' && depth === 0) {
						if (currentItem.trim()) {
							items.push(currentItem.trim());
						}
						currentItem = "";
					} else {
						currentItem += char;
					}
				}
			
				// Push any remaining item
				if (currentItem.trim()) {
					items.push(currentItem.trim());
				}

				return [items, items.map(item => infer_data_type(item))];
			}	
			
			function infer_list_of_formulas_item_types(listValue: string): [string[], string[]]{
				const items: string[] = [];
				const listItemTypes: string[] = [];

				const outerBracesRegex = /{([^{}]*)}/gs;  // Matches everything inside outermost curly braces
				const formulaRegex = /(\S+.*?\.\s*)/gs;   // Matches each individual formula
				
				let match;
				let formulaMatch;
				
				while ((match = outerBracesRegex.exec(listValue)) !== null) {
					let insideBraces = match[1]; 

					while ((formulaMatch = formulaRegex.exec(insideBraces)) !== null) {
						const listElement = formulaMatch[1].trim();
						items.push(listElement);
						listItemTypes.push("formula");
					}
				}
				
				return [items, listItemTypes];
			}

			/**
			 * Extracts the potential variable types for each variable.
			 * @param text The variable text
			 * @param variableTypes The list of possible variable types, Note it will change.
			 * @param xsdValues The types of the arguments.
			 * @returns True if the variable text got assigned a value
			 */
			function get_variable_types(text: string, variableTypes:Record<string, string>, xsdValues:string[]): boolean {
				if(xsdValues.length == 0)
					return false;
				variableTypes[text]="";
				xsdValues.forEach((type:string) => {
					variableTypes[text] += `${type} `;
				});
				variableTypes[text] = variableTypes[text].slice(0, -1);
				
				// If the variable was not declared before, add it and its type into variablesMap
				if (variablesMap.get(text) === undefined) {
					variablesMap.set(text, variableTypes[text]);
				}
				return true;
			}
			
			// Ensure that ctx and its children are defined
			if (!ctx || !ctx.children || ctx.children.length < 2) {
				connection.console.warn("Invalid context or missing elements in triple.");
				return;
			}
		
			const subject: any = ctx.children[0];
			const predicateObjectList: any = ctx.children[1];
		
			// Check if predicateObjectList has the required children
			if (!predicateObjectList.children || predicateObjectList.children.length < 2) {
				connection.console.warn("Invalid predicate-object list in triple.");
				return;
			}
		
			const verb = predicateObjectList.children[0];
			const objectList = predicateObjectList.children[1];
		
			// Check if objectList has at least one child
			if (!objectList.children || objectList.children.length === 0) {
				connection.console.warn("Invalid object list in triple.");
				return;
			}
		
			const object = objectList.children[0];
		
			const subjectText = ctx_text(subject);
			const subjectType = infer_data_type(subjectText);
		
			const objectText = ctx_text(object);
			const objectType = infer_data_type(objectText);
			
			// Construct the output string, ensuring the expected type is included
			let output = `subject: ${subjectText} (rule: ${term_prod(subject)}, type: ${subjectType})\n` +
				`verb (first): ${ctx_text(verb)} (rule: ${term_prod(verb)})\n` +
				`object (first): ${ctx_text(object)} (rule: ${term_prod(object)}, type: ${objectType})`;
		
			let subjectItems: string[] = [];
			let objectItems: string[] = [];

			let subjectListItemTypes: string[] = [];
			let objectListItemTypes: string[] = [];  // Separate array for object list item types
		
			// Check and infer subject list item types
			if (subjectType === "list") {
				[subjectItems, subjectListItemTypes] = infer_list_item_types(subjectText);
				output += `\nSubject list item types: ${subjectListItemTypes.join(", ")}`;
			} else if (subjectType === "listOfFormulas") {
				[subjectItems, subjectListItemTypes] = infer_list_of_formulas_item_types(subjectText);
				output += `\nSubject list item types: ${subjectListItemTypes.join(", ")}`;
			}
		
			// Check and infer object list item types
			if (objectType === "list") {
				[objectItems, objectListItemTypes] = infer_list_item_types(objectText);
				output += `\nObject list item types: ${objectListItemTypes.join(", ")}`;
			} else if (objectType === "listOfFormulas") {
				[objectItems, objectListItemTypes] = infer_list_of_formulas_item_types(objectText);
				output += `\nObject list item types: ${objectListItemTypes.join(", ")}`;
			}
				
			connection.console.log(output);
		
			const verbText = ctx_text(verb);
			
			let [prefix, func] = new Array<string>(2);

			if (verbText.includes(':')) {
				[prefix, func] = verbText.split(':');
			} else if (verbText === '=>' || verbText === '<=') {  // Handle special cases for '=>' and '<='
				const correspondingFunction = verbText === '=>' ? 'log:implies' : 'log:impliedBy';
				connection.console.log(`The verb "${verbText}" is recognized as a shorthand for "${correspondingFunction}".`);
				[prefix, func] = correspondingFunction.split(':');
				// Handle the logic as needed for these cases, no need for prefix validation
			} else {
				connection.console.warn("Invalid verb format; missing prefix and function.");
				return;
			}
		
			if (subjectText && verbText && objectText) {
				checkFunctionInPrefix(prefix, func).then(functionExists => {
					if (functionExists) {
						connection.console.log(`The function "${func}" exists in the prefix "${prefix}".`);
		
						generateAndLaunchURL(prefix, func).then(async (result) => {
							if (!result.success) {
								if (result.message === "Error: The URL does not exist (404 Not Found)") {
									connection.console.log(`Specifications for "${prefix}:${func}" are not given on GitHub [${result.message}]`);
								} else {
									//connection.console.error(result.message);
									console.error(result.message);
								}
                                
                                return;  // Halt the validateTextDocument function
                            }
							if (!hasSyntaxError) {  // Only compare types if no syntax error occurred
								const { fnoTypes, xsdValues, subjectTypes, objectTypes, listElementInfo } = await fetchAndExtractParameters(`https://github.com/w3c-cg/n3Builtins/blob/main/spec/src/${prefix}/${func}.n3`);
		
								const typeMapping: Record<string, string> = {
									"rdf:List": "list",  // Treat rdf:List as a list
									"xsd:float": "float",
									"xsd:decimal": "decimal",
									"xsd:string": "string",
									"rdf:Function": "function",
									"log:Formula": "listOfFormulas",  // Maps log:Formula to listOfFormulas
									"xsd:double": "double",
									"log:Uri": "uri"  // URI mapping
								};
		
								if (subjectType === "variable" && get_variable_types(subjectText, variableTypes, xsdValues)) {
									let varCurrentType = variablesMap.get(subjectText);
									let varExpectedType = variableTypes[subjectText];
									if (varCurrentType !== undefined && varCurrentType !== varExpectedType) {
										connection.console.warn(
											`The variable "${subjectText}" was previously declared as "${varCurrentType}". The expected type is "${varExpectedType}".`
										);
									} else {
										connection.console.log(`The variable "${subjectText}" has an expected type of "${variableTypes[subjectText]}".`);
									}
								}
								
								if (objectType === "variable" && get_variable_types(objectText, variableTypes, xsdValues)) {
									let varCurrentType = variablesMap.get(objectText);
									let varExpectedType = variableTypes[objectText];
									// if the variable was declared before AND if the declared type is not the same as expected type
									if (varCurrentType !== undefined && varCurrentType !== varExpectedType) {
										connection.console.warn(
											`The variable "${objectText}" was previously declared as "${varCurrentType}". The expected type is "${varExpectedType}".`
										);
									} else {
										connection.console.log(`The variable "${objectText}" has an expected type of "${varExpectedType}".`);
									}
								}
								
		
								// Prepare the set of expected types
								const expectedTypes = new Set<string>(xsdValues.map(type => typeMapping[type] || type));
								
								// Subject type matching test
								let subjectTypeMatched = false;
								for (const fnoType of subjectTypes) {
									if (subjectType === "variable" || 
										typeMapping[fnoType] === subjectType || 
										(fnoType === "rdf:List" && subjectType === "listOfFormulas") || 
										(fnoType === "log:Formula" && subjectType === "list")) {
										connection.console.log(`The subject type ${subjectType} and fno:type "${fnoType}" match.`);
										subjectTypeMatched = true;
										break;
									}
								}
								
								if (!subjectTypeMatched) {
									for (const fnoType of subjectTypes) {
										connection.console.warn(`The subject type "${subjectType}" and fno:type "${fnoType}" do not match.`);
									}
								}

								// Track variables already logged to avoid duplicates
								const loggedVariables: Set<string> = new Set();
								
								// Check if the subject is a list, then validate each item type
								if (subjectType === "list" || subjectType === "listOfFormulas") {
									let listItems:string[] = []; 
									let items:string [] = [];

									if (subjectType === "list") {
										[items, listItems] = infer_list_item_types(subjectText);
									} else {
										[items, listItems] = infer_list_of_formulas_item_types(subjectText);
									}
								
									// Initialize expected types for the subject list items
									//const subjectExpectedTypes: (string | string[])[] = listItems.map(() => "undefined");
									let subjectExpectedTypes: (string | string[])[] = listItems.map(() => "undefined");
									
									// Log the full listElementInfo to see if it's being populated
									//connection.console.log(`listElementInfo: ${JSON.stringify(listElementInfo, null, 2)}`);

									// Dynamically extract expected types from listElementInfo for subject
									listElementInfo[0]?.subjectListElementTypes?.forEach((expectedType, index) => {
										expectedType = expectedType.trim()|| "undefined";;
									
										if (expectedType.includes('owl:unionOf')) {
											// Parse the union types from the expected type
											const unionTypeMatch = expectedType.match(/owl:unionOf\s*\((.*?)\)/);
											if (unionTypeMatch) {
												const unionTypes = unionTypeMatch[1].match(/xsd:\w+/g);  // Extract individual xsd types
												subjectExpectedTypes[index] = unionTypes ? unionTypes : ["undefined"]; // Store parsed types or undefined
											}
										} else if (expectedType.includes('xsd')) {
											subjectExpectedTypes[index] = expectedType;  // Assign single XSD type
										} else if (expectedType.startsWith('rdf:')) {
											subjectExpectedTypes[index] = expectedType;  // Assign RDF type	
										} else if (expectedType.startsWith('log:')) {
											subjectExpectedTypes[index] = expectedType;  // Assign LOG type	
										} else {
											subjectExpectedTypes[index] = "undefined";  // Default to undefined if no specific type is found
										}

										//connection.console.log(`Extracted expected type for index ${index}: ${subjectExpectedTypes[index]}`);
									});
									
									// Log the final `subjectExpectedTypes` array
									//connection.console.log(`Final subject expected types: ${subjectExpectedTypes}`);
																										
									// Ensure all list elements get the same expected type if the function specifies a single type for the list
									if (listElementInfo[0]?.subjectListElementTypes?.length === 1) {
										for (let i = 0; i < listItems.length; i++) {
											subjectExpectedTypes[i] = subjectExpectedTypes[0];  // Apply the same type to all list elements
											//connection.console.log(`Extracted expected type for index ${i}: ${subjectExpectedTypes[i]}`);
										}
									}
								
									// Process the variables and validate against the extracted expected types
									const itemValidationResults = listItems.map((item, index) => {
										const expectedTypeString = subjectExpectedTypes[index] || "undefined";
										const actualValue = items[index];
									
										// Split expectedTypeString into an array if it's a string of multiple types
										const expectedTypes = Array.isArray(expectedTypeString) ? expectedTypeString : expectedTypeString.split(", ");
										//const expectedTypes = Array.isArray(subjectExpectedTypes[index]) ? subjectExpectedTypes[index] : [subjectExpectedTypes[index]];
								
										// Extract variable names from the subject text
										const variableMatch = subjectText.match(/\?[^\s()]+/g);
								
										if (variableMatch) {
											variableMatch.forEach((variableName, i) => {
												// Log only if this variable hasn't been logged yet
												if (!loggedVariables.has(variableName)) {
													get_variable_types(variableName, variableTypes, xsdValues);
													const varExpectedType = variableTypes[variableName] || "undefined";
													let varCurrentType = variablesMap.get(variableName);
													if (varCurrentType !== undefined && varCurrentType !== varExpectedType) {
														connection.console.warn(
															`The variable "${variableName}" was previously declared as "${varCurrentType}". The expected type is "${varExpectedType}".`
														);
													} else {
														connection.console.log(`The variable "${variableName}" is of expected type "${varExpectedType}"`);
													}
													loggedVariables.add(variableName);  // Mark this variable as logged
												}
											});
										}

										if (item === "variable") {
											//console.log(`    -> Item "${item}" is a variable and is automatically valid.`);
											return {
												type: item,
												expectedType: expectedTypes.join(", "),
												isValid: true,  // Variables are always valid
												value: actualValue
											};
										}

										// If the expected type is a union of types, check if the item matches any of the expected types
										// If the expected type is rdf:List or log:Formula, check if the item is list or formula
										function mapToXsdRdfLogType(itemType: string) {
											switch (itemType) {
												case "float":
													return ["xsd:float", "xsd:double", "xsd:decimal"];
												case "decimal":
													return ["xsd:decimal"];
												case "double":
													return ["xsd:double"];
												case "list":
													return ["rdf:List"];
												case "formula":
													return ["log:Formula"];
												default:
													return [itemType];
											}
										}

										const itemXsdRdfLogTypes = mapToXsdRdfLogType(item); // Convert item to its XSD equivalents

										// If the expected type is a union of types, check if the item matches any of the expected types
										const isValidXsdType = itemXsdRdfLogTypes.some((itemXsdRdfLogType) => {
											const isTypeValid = expectedTypes.includes(itemXsdRdfLogType);
											//console.log(`    -> Comparing item XSD type "${itemXsdType}" with expected types "${expectedTypes.join(", ")}"`);
											//console.log(`    -> Is this valid? ${isTypeValid ? "Yes" : "No"}`);
											return isTypeValid;
										});
									
										// Check if the item matches any expected type directly
										const isValidSingleType = expectedTypes.includes(item) ||
																  (expectedTypes.includes("xsd:string") && item === "string") ||
																  (expectedTypes.includes("xsd:float") && item === "float") ||
																  (expectedTypes.includes("xsd:decimal") && item === "decimal") ||
																  expectedTypes.includes("undefined");
									
										// Combine the XSD type check with single type validation logic
										const isValid = isValidXsdType || isValidSingleType;
									
										return {
											type: item,
											expectedType: expectedTypes.join(", "),  // Join expected types for logging if it's an array
											isValid,
											value: actualValue
										};
									});
									

									const validItems = itemValidationResults.filter(result => result.isValid);
									const invalidItems = itemValidationResults.filter(result => !result.isValid );  // Exclude variables from invalid items
								
									let message = `The list item datatypes of subject "${subjectText}" (list item types: ${listItems.join(", ")}) `;

									// Check for valid items and append the message
									if (validItems.length > 0) {
										const validItemMessages = validItems.map(item => {
											return `Type: ${item.type}, Value: ${item.value} (expected: ${item.expectedType})`;
										});
										message += `match the expected xsd:type values. Valid items: ${validItemMessages.join(", ")}. `;
									}
									
									// Check for invalid items and print a warning instead of appending to the message
									if (invalidItems.length > 0) {
										const invalidItemMessages = invalidItems.map(item => {
											return `Type: ${item.type}, Value: ${item.value} (expected: ${item.expectedType})`;
										});
										
										// Print a warning specifically for the invalid items
										connection.console.warn(`Invalid items detected: ${invalidItemMessages.join(", ")}.`);
									}
									
									// Log the final message only for valid items (if any)
									connection.console.log(message);
									

									// Additional checks for element counts (if needed)
									if (listElementInfo[0]?.subjectElementCount !== undefined) {
										const expectedSubjectNumber = listElementInfo[0].subjectElementCount;
										const subjectItemNumber = validItems.length + invalidItems.length;
										if (subjectItemNumber !== expectedSubjectNumber) {
											connection.console.warn(`Subject list's element number does not match the expected number of elements:\n` +
												`\tExpected element number is ${expectedSubjectNumber}, current number is ${subjectItemNumber}`);
										} else {
											connection.console.log(`Subject list's element number matches the expected number of elements.`);
										}
									}
								}
								
								// Object type matching test
								let objectTypeMatched = false;
								
								// Iterate over the extracted object types and try to match them with the actual object type
								for (const fnoType of objectTypes) {
									if (objectType === "variable" || 
										typeMapping[fnoType] === objectType || 
										(fnoType === "xsd:string" && objectType === "string") ||  // Ensure xsd:string matches string
										(fnoType === "rdf:List" && objectType === "listOfFormulas") || 
										(fnoType === "log:Formula" && objectType === "list")) {
										connection.console.log(`The object data type ${objectType} and fno:type "${fnoType}" match.`);
										objectTypeMatched = true;
										break;
									}
								}
								
								// Log a message if no match is found for the object type
								if (!objectTypeMatched) {
									for (const fnoType of objectTypes) {
										connection.console.warn(`The object type "${objectType}" and fno:type "${fnoType}" do not match.`);
									}
								}
								
																							
								// Check if the object is a list, then validate each item type
								const variableTypeLogged: Record<string, boolean> = {};
								
								// Check if the object is a list, then validate each item type
								if (objectType === "list" || objectType === "listOfFormulas") {
									let listItems:string[] = []; 
									let items:string [] = [];
									
									if (objectType === "list") {
										[items, listItems] = infer_list_item_types(objectText);
									} else {
										[items, listItems] = infer_list_of_formulas_item_types(objectText);
									}
									
								
									// Define expected types for each item in the object list, based on the extracted structure
									const objectExpectedTypes: (string | undefined)[] = [];
								
									// Set expected types for the object list items (e.g., xsd:integer for $o.1)
									listElementInfo[0]?.objectListElementTypes?.forEach((expectedType, index) => {
										objectExpectedTypes[index] = expectedType || "undefined"; // Assign "undefined" if no specific type is defined
									});
								
									// Extract variable names from the object text
									const variableNames = (objectText.match(/\?[^\s()]+/g) || []).map(name => name.trim());
								
									// Process each item in the list, including variables
									const itemValidationResults = listItems.map((item, index) => {
										let expectedType = objectExpectedTypes[index] || "undefined"; // Get the expected type for this list item
								
										// If it's a variable, check if we already have an expected type for it from earlier analysis
										const variableName = variableNames.find((name: string) => objectText.includes(name));
										if (variableName && variableTypes[variableName]) {
											expectedType = variableTypes[variableName]; // Assign the correct expected type for the variable
								
											// Log the expected type for the variable
											if (!variableTypeLogged[variableName]) {
												connection.console.log(`The variable "${variableName}" in list has an expected type of "${expectedType}".`);
												variableTypeLogged[variableName] = true; // Mark that we've logged this variable
											}
										} else if (variableName && !variableTypeLogged[variableName]) {
											// If no explicit type is found for the variable, display it as having no expected type
											expectedType = objectExpectedTypes[index] || "undefined";  // If expected type exists for this position, apply it
											connection.console.log(`The variable "${variableName}" in list is expected to be of type "${expectedType}".`);
											variableTypeLogged[variableName] = true; // Mark that we've logged this variable
										}
								
										// Validate the item
										const isValid = item === "variable" || expectedType === "undefined" || expectedType === "any type" || expectedType === item ||
											(item === "float" && expectedType === "xsd:integer"); // Allow float -> integer coercion
								
										return { type: item, expectedType, isValid };
									});
								
									const validItems = itemValidationResults.filter(result => result.isValid);
									const invalidItems = itemValidationResults.filter(result => !result.isValid);
								
									if (validItems.length > 0) {
										connection.console.log(
											`The list item datatypes of object "${objectText}" (list item types: ${listItems.join(", ")}) ` +
											`include valid types. Valid items: ${validItems.map(item => item.type).join(", ")}.`
										);
									}
								
									if (invalidItems.length > 0) {
										connection.console.warn(
											`The list item datatypes of object "${objectText}" (list item types: ${listItems.join(", ")}) ` +
											`do not match the expected types. Invalid items: ${invalidItems.map((item, index) => `${objectText.split(/[()]/)[1].split(" ")[index]} (expected: ${item.expectedType})`).join(", ")}.`
										);
										}									
								
									// Check whether the object list needs to have a predefined number of elements
									if (listElementInfo[0]?.objectElementCount !== undefined) {
										const expectedObjectNumber = listElementInfo[0].objectElementCount;
										const objectItemNumber = validItems.length + invalidItems.length;
										if (objectItemNumber !== expectedObjectNumber) {
											connection.console.warn(
												`Object list's element number does not match with the expected number of elements:\n` +
												`\tExpected element number is ${expectedObjectNumber}, current number is ${objectItemNumber}`
											);
										} else {
											connection.console.log(
												`Object list's element number matches with the expected number of elements.`
											);
										}
									}								
								}																																						  
							} 
							else {
								connection.console.log("Skipping type comparison due to syntax error.");
							}
						});
					} else if (prefix !== "") {
						connection.console.warn(`The function "${func}" does not exist in the prefix "${prefix}".`);
						
						// Check for misspelling (only for uppercase mistake in one-word functions)
						let correctFunc = "";
						checkFunctionInPrefix(prefix, correctFunc=func.toLowerCase()).then(functionExists => {
							if (functionExists) {
								connection.console.log(`\tDid you mean "${correctFunc}" instead of "${func}"?`);
							}
						});
					}
				});
			} else {
				connection.console.warn("The input is not a valid triple.");
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
