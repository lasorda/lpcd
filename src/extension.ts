import { kStringMaxLength } from 'buffer';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

var sscanf = require('sscanf');

const cocLpcConfig = vscode.workspace.getConfiguration('coc-lpcd');
const workspaceStr = cocLpcConfig.get<string>("workspace", "newtxii");
const complieCommand = cocLpcConfig.get<string>("complie", "compile");
const efuncObjects = cocLpcConfig.get<Array<string>>('efunc', ["/etc/efun_define.c", "/sys/object/simul_efun.c"]);

var projectFolder: string = "";
var inc: string = "";

function debug(message: any, ...args: any) {
    console.log(message, ...args);
}

function uri2path(uri: vscode.Uri): string {
    return uri.path;
}

function getFileRelativePath(uri: vscode.Uri): string {
    return path.relative(projectFolder, uri2path(uri));
}

function initProjectFolder() {
    if (vscode.workspace.workspaceFolders === undefined) {
        return;
    }
    let curPath = vscode.workspace.workspaceFolders[0].uri.path.toString();
    let pos = curPath.lastIndexOf(workspaceStr);

    if (pos >= 0) {
        projectFolder = curPath.slice(0, pos + `${workspaceStr}/`.length);
        inc = path.resolve(projectFolder, cocLpcConfig.get<string>('include', "inc"));
    }
    debug(`coc-lpcd init with workspace:${workspaceStr} complie:${complieCommand} include:${inc} efunc:${efuncObjects}`);
};

function complie(filename: string): Boolean {
    try {
        // too ugly
        child_process.execSync(`cd ${projectFolder}; mv log/debug.log log/bak.log; ${complieCommand} ${filename}; mv log/debug.log log/complie.log ; mv log/bak.log log/debug.log`, { shell: "/bin/bash", stdio: "pipe" });
        return true;
    } catch (e) {
        debug(e);
        return false;
    }
}

const symbolDir = 'log/symbol/';

function loadSymbol(filename: string) {
    if (filename.startsWith("/")) {
        filename = filename.substring(1);
    }
    filename = filename.replace(/\//g, "#");
    let absFilename = path.resolve(projectFolder, symbolDir, filename);
    if (!fs.existsSync(absFilename)) {
        return "";
    }
    return fs.readFileSync(absFilename).toString();
}

enum OP {
    pInc = 1,
    pDefine,
    pVar,
    pFunc,
    pNew,
    pPop,
    pFree,
}

interface LineSymbol {
    op: OP,
    filename: string,
    lineno: number,
    detail: string,
}

interface Symbol {
    name: string,
    line: number,
    filename: string,
    args?: string[],
    op?: LineSymbol[],
    detail?: string,
}

interface FileSymbol {
    lineno: number;
    defined: Symbol[],
    include: Symbol[],
    variable: Symbol[],
    func: Symbol[],
    childFileSymbol: { [key: string]: FileSymbol },
}

function parse(filename: string, symbolInfo: string) {
    let lineInfo = symbolInfo.split('\n');
    let fileSymbol: FileSymbol = {
        defined: [],
        include: [],
        variable: [],
        func: [],
        childFileSymbol: {},
        lineno: 0
    };
    let localArgs: string[] = [];
    let currentLine = 0;
    let hasIncluded = new Set();
    let lastFunction: Symbol | null = null;

    lineInfo.forEach(line => {
        if (line.length === 0) { return; }

        let lineSymbol: LineSymbol = sscanf(line, "%d %s %d %S", 'op', 'filename', 'lineno', 'detail');
        let targetSymbol: FileSymbol | undefined = fileSymbol;

        if (!lineSymbol.detail) { lineSymbol.detail = ""; }

        if (lineSymbol.filename === filename) { currentLine = lineSymbol.lineno; }

        if (lineSymbol.filename !== filename) {
            if (!fileSymbol.childFileSymbol[lineSymbol.filename]) {
                fileSymbol.childFileSymbol[lineSymbol.filename] = {
                    defined: [],
                    include: [],
                    variable: [],
                    func: [],
                    childFileSymbol: {},
                    lineno: lineSymbol.lineno
                };
            }
            targetSymbol = fileSymbol.childFileSymbol[lineSymbol.filename];
        }
        if (targetSymbol) {
            switch (lineSymbol.op) {
                case OP.pInc:
                    if (!hasIncluded.has(lineSymbol.filename)) {
                        fileSymbol.include.push({
                            name: lineSymbol.filename,
                            line: currentLine,
                            filename: lineSymbol.filename
                        });
                        hasIncluded.add(lineSymbol.filename);
                    }
                    break;
                case OP.pDefine:
                    let hasArgs = 0;
                    let define = lineSymbol.detail.trim();
                    let spacePos = define.search(`\\s+`);

                    for (let index = 0; index < spacePos; index++) {
                        const element = define[index];
                        if (element === '(') {
                            hasArgs = index;
                            break;
                        }
                    }
                    if (hasArgs) {
                        let right = hasArgs;
                        while (right < define.length && define[right] !== ')') { right++; }
                        let args = define.substring(hasArgs + 1, right).replace(/,/gi, ' ').split(' ');
                        args = args.filter(function (value: string) {
                            return value.length > 0;
                        });
                        targetSymbol.defined.push({
                            name: define.substring(0, hasArgs),
                            line: lineSymbol.lineno,
                            args: args,
                            filename: lineSymbol.filename,
                            detail: lineSymbol.detail.substring(right + 1, lineSymbol.detail.length).trim()
                        });
                    }
                    else {
                        if (spacePos < 0) {
                            targetSymbol.defined.push({
                                name: define,
                                line: lineSymbol.lineno,
                                filename: lineSymbol.filename,
                                detail: undefined,
                            });
                        }
                        else {
                            targetSymbol.defined.push({
                                name: define.substring(0, spacePos),
                                line: lineSymbol.lineno,
                                filename: lineSymbol.filename,
                                detail: lineSymbol.detail.substring(spacePos, lineSymbol.detail.length).trim()
                            });
                        }
                    }
                    break;
                case OP.pVar:
                    targetSymbol.variable.push({
                        name: lineSymbol.detail,
                        line: lineSymbol.lineno,
                        filename: lineSymbol.filename
                    });
                    break;
                case OP.pFunc:
                    targetSymbol.func.push({
                        name: lineSymbol.detail,
                        line: lineSymbol.lineno,
                        args: [...localArgs],
                        op: [],
                        filename: lineSymbol.filename
                    });
                    lastFunction = targetSymbol.func[targetSymbol.func.length - 1];
                    break;
                case OP.pNew:
                    localArgs.push(lineSymbol.detail);
                    if (lastFunction && lastFunction.op) {
                        lastFunction.op.push(lineSymbol);
                    }
                    break;
                case OP.pPop:
                    let n = parseInt(lineSymbol.detail);
                    while (localArgs.length > 0 && n > 0) {
                        localArgs.pop();
                        n--;
                    }
                    if (lastFunction && lastFunction.op) {
                        lastFunction.op.push(lineSymbol);
                    }
                    break;
                case OP.pFree:
                    localArgs = [];
                    if (lastFunction && lastFunction.op) {
                        lastFunction.op.push(lineSymbol);
                    }
                    break;
                default:
            }
        }
    });
    return fileSymbol;
}

var fileSymbolCache: { [key: string]: FileSymbol } = {};
var fileSymbolCacheTime: { [key: string]: number } = {};

function generateFileSymbol(filename: string): FileSymbol {
    let fileSymbol: FileSymbol = { defined: [], include: [], variable: [], func: [], childFileSymbol: {}, lineno: 0 };
    if (filename in fileSymbolCacheTime && (Date.now() / 1000 - fileSymbolCacheTime[filename] < 1)) {
        return fileSymbolCache[filename];
    }

    if (!complie(filename)) {
        if (filename in fileSymbolCache) { return fileSymbolCache[filename]; }
        return fileSymbol;
    }
    let res = loadSymbol(filename);
    fileSymbol = parse(filename, res);
    fileSymbolCache[filename] = fileSymbol;
    fileSymbolCacheTime[filename] = Date.now() / 1000;
    return fileSymbol;
}

/**
 * for object call function completion
 */
function getDefineFunction(filename: string, line: number, includeChild: Boolean): Symbol[] {
    let ret: Symbol[] = [];
    let fileSymbol = generateFileSymbol(filename);

    fileSymbol.func.forEach(func => {
        if (line < 0 || func.line <= line) {
            ret.push(func);
        }
    });

    if (includeChild) {
        for (var file in fileSymbol.childFileSymbol) {
            let childSymbol = fileSymbol.childFileSymbol[file];
            if (line < 0 || childSymbol.lineno <= line) {
                ret.push(...childSymbol.func);
            }
        }
    }
    return ret;
}

/**
 * include efun and simul_efun, for completion in this file
 */
function getVisibleFunction(filename: string, line: number): Symbol[] {
    let res = getDefineFunction(filename, line, true);
    efuncObjects.forEach(efuncFile => {
        res.push(...getDefineFunction(prettyFilename(efuncFile), -1, true));
    });
    return res;
}

function getMacroDefine(filename: string, line: number, includeChild: Boolean): Symbol[] {
    let ret: Symbol[] = [];
    let fileSymbol = generateFileSymbol(filename);

    fileSymbol.defined.forEach(defined => {
        if (line < 0 || defined.line <= line) {
            ret.push(defined);
        }
    });

    if (includeChild) {
        for (var file in fileSymbol.childFileSymbol) {
            let childSymbol = fileSymbol.childFileSymbol[file];

            if (line < 0 || childSymbol.lineno <= line) {
                ret.push(...childSymbol.defined);
            }
        }
    }
    return ret;
}

function getGlobalVariable(filename: string, line: number, includeChild: Boolean): Symbol[] {
    let ret: Symbol[] = [];
    let fileSymbol = generateFileSymbol(filename);

    fileSymbol.variable.forEach(variable => {
        if (line < 0 || variable.line <= line) {
            ret.push(variable);
        }
    });

    if (includeChild) {
        for (var file in fileSymbol.childFileSymbol) {
            let childSymbol = fileSymbol.childFileSymbol[file];

            if (line < 0 || childSymbol.lineno <= line) {
                ret.push(...childSymbol.variable);
            }
        }
    }
    return ret;
}

function getLocalVariable(filename: string, lineAt: number): Symbol[] {
    let localArgs: Symbol[] = [];
    let fileSymbol = generateFileSymbol(filename);
    let lastFunction: Symbol | null = null;

    for (let index = 0; index < fileSymbol.func.length; index++) {
        const func = fileSymbol.func[index];
        if (func.line <= lineAt) {
            lastFunction = func;
        }
        else {
            break;
        }
    }
    if (lastFunction && lastFunction.args && lastFunction.op) {
        for (let index = 0; index < lastFunction.args.length; index++) {
            const arg = lastFunction.args[index];
            localArgs.push({ name: arg, line: lastFunction.line, filename: filename });
        }
        for (let index = 0; index < lastFunction.op.length; index++) {
            const lineSymbol = lastFunction.op[index];

            if (lineSymbol.lineno > lineAt) { break; }

            switch (lineSymbol.op) {
                case OP.pNew:
                    localArgs.push({
                        name: lineSymbol.detail,
                        line: lineSymbol.lineno,
                        filename: lineSymbol.filename
                    });
                    break;
                case OP.pPop:
                    let n = parseInt(lineSymbol.detail);
                    while (localArgs.length > 0 && n > 0) {
                        localArgs.pop();
                        n--;
                    }
                    break;
                case OP.pFree:
                    localArgs = [];
                    break;
                default:
            }
        }
    }
    return localArgs;
}

function getLine(document: vscode.TextDocument, line: number): string {
    return document.lineAt(line).text;
}

var completionCache: { [key: string]: vscode.CompletionItem[] } = {};
var completionCacheTime: { [key: string]: number } = {};

function provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const line = getLine(document, position.line);
    const lineText = line.substring(0, position.character);
    let reg: RegExp;

    // #include <
    reg = /#include\s+?(<)\w*?$/;
    if (reg.test(lineText)) {
        let result = getFileAndDir(inc);
        return result;
    }

    // #include "
    reg = /#include\s+?(\")([\w|\/]*?)$/;
    if (reg.test(lineText)) {
        let execResult = reg.exec(lineText);
        let result: vscode.CompletionItem[] = [];

        if (execResult) {
            if (execResult[2].search('/') === -1) { result.push(...getFileAndDir(inc)); }
            let dir = execResult[2].split("/");
            let target = "";

            dir.pop();
            if (!execResult[2].startsWith("/")) {
                target = path.resolve(path.dirname(uri2path(document.uri)), ...dir);
            }
            else {
                target = path.resolve(projectFolder, ...dir);
            }
            result.push(...getFileAndDir(target));
        }
        return result;
    }

    // "cmd/"
    reg = /(\")([\w\/]*)$/;
    if (reg.test(lineText)) {
        let execResult = reg.exec(lineText);
        if (execResult !== null) {
            let dir = execResult[2].split("/");
            dir.pop();
            return getFileAndDir(path.resolve(projectFolder, ...dir));
        }
        return [];
    }

    // object call
    reg = /([\w\/\"\.]+|this_object\(\))->$/;
    if (reg.test(lineText)) {
        let execResult = reg.exec(lineText);
        let file = "";
        if (execResult === null) { return []; }
        if (execResult[1] === 'this_object()') {
            file = `"${getFileRelativePath(document.uri)}"`;
        } else {
            file = execResult[1];
        }
        if (!file.startsWith("\"")) {
            let define = getMacroDefine(getFileRelativePath(document.uri), position.line, true);
            for (let index = 0; index < define.length; index++) {
                const def = define[index];
                if (def.name === execResult[1] && def.detail) {
                    file = def.detail;
                }
            }
        }
        file = prettyFilename(file.substring(1, file.length - 1));
        let res: vscode.CompletionItem[] = [];
        let allFunction = getDefineFunction(file, -1, true);
        for (let index = 0; index < allFunction.length; index++) {
            const func = allFunction[index];
            res.push({
                label: func.name,
                kind: vscode.CompletionItemKind.Function,
                insertText: new vscode.SnippetString(func.name + makeSnippetPlaceHolderStr(func.args || []))
            });
        }
        return res;
    }

    if (lineText.endsWith(">")) { return []; }

    // call this file
    let filename = getFileRelativePath(document.uri);

    if (filename in completionCache && filename in completionCacheTime
        && Date.now() / 1000 - completionCacheTime[filename] < 5) {
        return completionCache[filename];
    }

    let res: vscode.CompletionItem[] = [];
    for (const local of getLocalVariable(filename, position.line)) {
        res.push({
            label: local.name,
            kind: vscode.CompletionItemKind.Variable,
            insertText: local.name,
        });

    }
    for (const func of getVisibleFunction(filename, position.line)) {
        res.push({
            label: func.name,
            kind: vscode.CompletionItemKind.Function,
            insertText: new vscode.SnippetString(func.name + makeSnippetPlaceHolderStr(func.args || []))
        });
    }
    for (const define of getMacroDefine(filename, position.line, true)) {
        if (define.args) {
            res.push({
                label: define.name,
                kind: vscode.CompletionItemKind.Function,
                insertText: new vscode.SnippetString(define.name + makeSnippetPlaceHolderStr(define.args || []))
            });
        }
        else {
            res.push({
                label: define.name,
                kind: vscode.CompletionItemKind.Constant,
                insertText: define.name,
            });
        }
    }
    for (const variable of getGlobalVariable(filename, position.line, true)) {
        res.push({
            label: variable.name,
            kind: vscode.CompletionItemKind.Variable,
            insertText: variable.name,
        });
    }
    completionCache[filename] = res;
    completionCacheTime[filename] = Date.now() / 1000;
    return res;
}

function makeSnippetPlaceHolderStr(args: string[]): string {
    let res = "";
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (index > 0) {
            res += ", ";
        }
        res += "${" + (index + 1) + ":" + arg.trim() + "}";
    }
    return "(" + res + ")";
}

function prettyFilename(filename: string): string {
    if (filename.startsWith("/")) { filename = filename.substring(1); }
    if (!filename.endsWith(".c")) { filename = filename + ".c"; }
    return path.resolve("/", ...filename.replace(/\//, ' ').split(' ')).substring(1);
}

function getFileAndDir(dirPath: string): vscode.CompletionItem[] {
    let output: vscode.CompletionItem[] = [];

    if (!fs.existsSync(dirPath)) { return output; }

    let files = fs.readdirSync(dirPath);

    for (let i = 0; i < files.length; ++i) {
        let filedir = path.join(dirPath, files[i]);
        let stats = fs.statSync(filedir);

        if (stats === null) { return []; }
        let isFile = stats.isFile();
        let isDir = stats.isDirectory();
        if (isFile && (filedir.search('\\.c') !== -1 || filedir.search('\\.h') !== -1)) {
            filedir = filedir.replace(dirPath, "").replace(/\\/g, '/').substr(1);
            output.push({ label: filedir, kind: vscode.CompletionItemKind.File, insertText: filedir });
        }
        else if (isDir) {
            filedir = filedir.replace(dirPath, "").replace(/\\/g, '/').substr(1) + "/";
            if (filedir.substring(0, 1) === '.') { continue; }
            output.push({
                label: filedir,
                kind: vscode.CompletionItemKind.Folder,
                insertText: filedir.replace('/', ''),
            });
        }
    }
    return output;
};

function searchInLine(line: string, word: string): number {
    let reg = new RegExp(`\\b${word}\\b`);
    if (reg.test(line)) {
        let execResult = reg.exec(line);
        if (execResult) {
            return execResult["index"];
        }
    }
    return 0;
}

var fileContextCache: { [key: string]: string[] } = {};
var fileContextCacheTime: { [key: string]: number } = {};

function getRangeofWordInFileLine(filename: string, line: number, word: string): vscode.Range {
    let res = { start: { line: line, character: 0 }, end: { line: line, character: 0 } };
    let filelines: string[] = [];

    if (fs.existsSync(filename)) {
        if (filename in fileContextCache && (Date.now() / 1000 - fileContextCacheTime[filename] < 1)) {
            filelines = fileContextCache[filename];
        }
        else {
            filelines = fs.readFileSync(filename).toString().split("\n");
            fileContextCache[filename] = filelines;
            fileContextCacheTime[filename] = Date.now() / 1000;
        }
    }
    if (line < filelines.length && filename.length > 0) {
        let linePos = searchInLine(filelines[line], word);
        res.start.character = linePos;
        res.start.character = linePos;
    }
    return new vscode.Range(new vscode.Position(res.start.line, res.start.character), new vscode.Position(res.end.line, res.end.character));
}

var lastdotcfile: string = "";

function getWordRangeAtPosition(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
    let line = getLine(document, position.line);
    let lineNumber = position.line;
    let left = position.character, right = position.character;
    while (left >= 0 && ((line[left] >= 'a' && line[left] <= 'z')
        || (line[left] >= 'A' && line[left] <= 'Z')
        || (line[left] >= '0' && line[left] <= '9')
        || line[left] === '_'
        || line[left] === '/')) {
        left--;
    }

    left++;
    while (right < line.length && ((line[right] >= 'a' && line[right] <= 'z')
        || (line[right] >= 'A' && line[right] <= 'Z')
        || (line[right] >= '0' && line[right] <= '9')
        || line[right] === '_'
        || line[right] === '/')) {
        right++;
    }

    return new vscode.Range(new vscode.Position(lineNumber, left), new vscode.Position(lineNumber, right));
}

function provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Definition> {
    const word = document.getText(getWordRangeAtPosition(document, position));
    const lineText = getLine(document, position.line);
    var filename = getFileRelativePath(document.uri);

    if (filename.endsWith(".c")) {
        lastdotcfile = filename;
    }
    else if (filename.endsWith(".h") && lastdotcfile.length) {
        // when deal with .h file, try best find 
        filename = lastdotcfile;
    }

    // -> call jump
    let reg = new RegExp(`([\\w\\/\\"\\.]+|this_object\\(\\))->${word.replace(/\//g, '\\/')}\\(`);
    let execResult = reg.exec(lineText);
    if (execResult !== null && execResult[1] !== null
        && execResult["index"] + execResult[1].length + 2 <= position.character
        && execResult["index"] + execResult[1].length + word.length >= position.character - 1) {
        let from = "";

        if (execResult[1] === 'this_object()') {
            from = `"${getFileRelativePath(document.uri)}"`;
        } else {
            from = execResult[1];
        }

        if (!from.startsWith("\"")) {
            let define = getMacroDefine(filename, position.line, true);
            for (let index = 0; index < define.length; index++) {
                const def = define[index];
                if (def.name === from && def.detail) {
                    from = def.detail;
                    break;
                }
            }
        }

        if (!from.startsWith("\"") || !from.endsWith("\"")) { return; }
        from = prettyFilename(from.substring(1, from.length - 1));
        if (!fs.existsSync(path.resolve(projectFolder, from))) { return; }
        let definefunc = getDefineFunction(from, -1, true);
        for (let index = 0; index < definefunc.length; index++) {
            const func = definefunc[index];
            if (func.name === word) {
                return {
                    uri: vscode.Uri.file(path.resolve(projectFolder, func.filename)),
                    range: getRangeofWordInFileLine(path.resolve(projectFolder, func.filename), func.line - 1, func.name),
                };
            }
        }
    }

    // #include <
    reg = /#include\s+?<([\w|\/|\.]+)*?>(\s+)?/;
    if (reg.test(lineText)) {
        let execResult = reg.exec(lineText);
        if (execResult) {
            let uri = path.resolve(inc, execResult[1]);
            if (fs.existsSync(uri)) {
                return {
                    uri: vscode.Uri.file(uri),
                    range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
                };
            }
        }
        return;
    }

    // #include "
    reg = /#include\s+?\"([\w|\/|\.]+)*?\"(\s+)?/;
    if (reg.test(lineText)) {
        let execResult = reg.exec(lineText);

        if (execResult) {
            let target = execResult[1];
            if (!target.startsWith("/")) {
                let inner = path.resolve(projectFolder, path.dirname(getFileRelativePath(document.uri)), target);
                if (fs.existsSync(inner)) {
                    return {
                        uri: vscode.Uri.file(inner),
                        range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
                    };
                }
                inner = path.resolve(inc, target);
                if (fs.existsSync(inner)) {
                    return {
                        uri: vscode.Uri.file(path.resolve(projectFolder, inner)),
                        range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
                    };
                }
                return null;
            }
            else {
                target = target.substring(1);
                return {
                    uri: vscode.Uri.file(path.resolve(projectFolder, target)),
                    range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
                };

            }
        }
        return;
    }

    // "cmd/"
    if (word.search(/\//) !== -1) {
        let target = prettyFilename(word);
        return {
            uri: vscode.Uri.file(path.resolve(projectFolder, target)),
            range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
        };
    }

    for (const local of getLocalVariable(filename, position.line)) {
        if (local.name === word) {
            return {
                uri: document.uri,
                range: getRangeofWordInFileLine(uri2path(document.uri), local.line - 1, local.name),
            };
        }
    }

    for (const variable of getGlobalVariable(filename, position.line, true)) {
        if (variable.name === word) {
            return {
                uri: vscode.Uri.file(path.resolve(projectFolder, variable.filename)),
                range: getRangeofWordInFileLine(path.resolve(projectFolder, variable.filename), variable.line - 1, variable.name),
            };
        }
    }

    for (const func of getDefineFunction(filename, position.line, true)) {
        if (func.name === word) {
            return {
                uri: vscode.Uri.file(path.resolve(projectFolder, func.filename)),
                range: getRangeofWordInFileLine(path.resolve(projectFolder, func.filename), func.line - 1, func.name),
            };
        }
    }

    for (let index = 0; index < efuncObjects.length; index++) {
        const efuncFile = efuncObjects[index];
        for (const func of getDefineFunction(efuncFile, position.line, true)) {
            if (func.name === word) {
                return {
                    uri: vscode.Uri.file(path.resolve(projectFolder, func.filename)),
                    range: getRangeofWordInFileLine(path.resolve(projectFolder, func.filename), func.line - 1, func.name),
                };
            }
        }
    }

    for (const define of getMacroDefine(filename, position.line, true)) {
        if (define.name === word) {
            return {
                uri: vscode.Uri.file(path.resolve(projectFolder, define.filename)),
                range: getRangeofWordInFileLine(path.resolve(projectFolder, define.filename), define.line - 1, define.name),
            };
        }
    }
    return null;
}

function provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    let filename = getFileRelativePath(document.uri);

    let output: vscode.DocumentSymbol[] = [];

    for (const define of getMacroDefine(filename, -1, false)) {
        output.push(new vscode.DocumentSymbol(define.name, define.detail || "",
            vscode.SymbolKind.Variable, getRangeofWordInFileLine(filename, define.line - 1, define.name),
            getRangeofWordInFileLine(filename, define.line - 1, define.name)));
    }
    for (const variable of getGlobalVariable(filename, -1, false)) {
        output.push(new vscode.DocumentSymbol(variable.name, variable.detail || "",
            vscode.SymbolKind.Variable, getRangeofWordInFileLine(filename, variable.line - 1, variable.name),
            getRangeofWordInFileLine(filename, variable.line - 1, variable.name)));
    }

    for (const func of getDefineFunction(filename, -1, false)) {
        output.push(new vscode.DocumentSymbol(func.name, func.detail || "",
            vscode.SymbolKind.Function, getRangeofWordInFileLine(filename, func.line - 1, func.name),
            getRangeofWordInFileLine(filename, func.line - 1, func.name)));
    }
    return output;
}

function lpcCompile() {
    if (vscode.window.activeTextEditor === undefined) {
        return;
    }
    let relativePath = vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri);
    let cmd = `cd ${projectFolder}/../engine && ./txos -b -f -C $(find . -name 'config\.[0-9]*') -a ${relativePath} 2>&1 | grep -v "^$"`;
    child_process.exec(cmd, function (error: any, stdout: string, stderr: string) {
        vscode.window.showQuickPick(stdout.split("\n"), { "placeHolder": "press ESC to exit" });
    });
}

function lpcTailDebug(tailLine: number) {
    if (vscode.window.activeTextEditor === undefined) {
        return;
    }
    let cmd = `cd ${projectFolder} && tail -n ${tailLine} log/debug.log`;
    child_process.exec(cmd, function (error: any, stdout: string, stderr: string) {
        vscode.window.showQuickPick(stdout.split("\n"), { "placeHolder": "press ESC to exit" });
    });
}

function lpcUpdateFile() {
    if (vscode.window.activeTextEditor === undefined) {
        return;
    }
    let updateRelativePath = vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri);
    let etcFilePath = path.resolve(projectFolder, "etc", "update");
    if (!fs.existsSync(etcFilePath)) {
        vscode.window.showErrorMessage("etc/update file not exit. update fail!!");
        return;
    }
    else {
        fs.writeFile(etcFilePath, "update " + updateRelativePath, (err) => {
            if (err) {
                vscode.window.showErrorMessage("write etc/update file error! path:" + etcFilePath);
            }
        });
        const msg = "write \"update " + updateRelativePath + "\" to etc/update done";
        vscode.window.showInformationMessage(msg);
    }
}

function lpcCallFunc() {
    if (vscode.window.activeTextEditor === undefined) {
        return;
    }
    let updateRelativePath = vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri);
    const etcFilePath = path.resolve(projectFolder, "etc", "update");
    if (!fs.existsSync(etcFilePath)) {
        vscode.window.showErrorMessage("etc/update file not exit. run func fail!!");
        return;
    }
    else {
        var editor = vscode.window.activeTextEditor;
        var selectText = editor.document.getText(editor.selection);
        if (typeof selectText === "string" && selectText.length > 0) {
            selectText = selectText + " ";
        } else {
            selectText = "";
        }
        vscode.window.showInputBox({ "value": selectText }).then(inputMsg => {
            if (inputMsg !== undefined) {
                fs.writeFile(etcFilePath, "testfunc " + updateRelativePath + " " + inputMsg, (err) => {
                    if (err) {
                        vscode.window.showErrorMessage("write etc/update file error! path:" + etcFilePath);
                    }
                });
                const msg = "write \"testfunc " + updateRelativePath + " " + inputMsg + "\" to etc/update done";
                vscode.window.showInformationMessage(msg);
            }
        });
    }
}

export function activate(context: vscode.ExtensionContext) {
    initProjectFolder();
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: "lpc", scheme: "file" }, { provideCompletionItems, }, "/", ">", "<"));
    context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: "lpc", scheme: "file" }, { provideDefinition }));
    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider({ language: "lpc", scheme: "file" }, { provideDocumentSymbols }));

    context.subscriptions.push(vscode.commands.registerCommand('lpcd.compile', () => { lpcCompile(); }));
    context.subscriptions.push(vscode.commands.registerCommand('lpcd.update_file', () => { lpcUpdateFile(); }));
    context.subscriptions.push(vscode.commands.registerCommand('lpcd.call_func', () => { lpcCallFunc(); }));
    [10, 20, 40, 80, 160, 320, 640, 1000].forEach(element => {
        context.subscriptions.push(vscode.commands.registerCommand(`lpcd.remote_tail_debug_${element}`, () => { lpcTailDebug(element); }));
    });
}

export function deactivate() { }
