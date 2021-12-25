import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import * as scanf from 'scanf';

const cocLpcdConfig = vscode.workspace.getConfiguration('coc-lpcd');
const workspaceStr = cocLpcdConfig.get<string>('workspace', 'newtxii');
const complieCommand = cocLpcdConfig.get<string>('complie', 'lpc_compile');
const efuncObjects = cocLpcdConfig.get<Array<string>>('efunc', ['/sys/object/simul_efun.c', '/etc/efun_define.c']);

let projectFolder = '';
let inc = '';


function debug(message: any, ...args: any) {
    console.log(message, ...args);
}

function uri2path(uri: vscode.Uri): string {
    return uri.path;
}

function getFileRelativePath(uri: vscode.Uri): string {
    return path.relative(projectFolder, uri2path(uri));
}

function initProjectFolder(context: vscode.ExtensionContext) {
    if (vscode.workspace.workspaceFolders === undefined) {
        return;
    }
    const curPath = vscode.workspace.workspaceFolders[0].uri.path.toString();
    const pos = curPath.lastIndexOf(workspaceStr);

    if (pos >= 0) {
        projectFolder = curPath.slice(0, pos + `${workspaceStr}/`.length);
        inc = path.resolve(projectFolder, cocLpcdConfig.get<string>('include', "inc"));
    }
    debug(`lpcd init with workspace:${workspaceStr} complie:${complieCommand} include:${inc} efunc:${efuncObjects}`);
}

function complie(filename: string): boolean {
    try {
        child_process.execSync(
            `cd ${projectFolder}; mkdir -p log && touch log/debug.log`,
            { shell: '/bin/bash', stdio: 'pipe' }
        );

        // too ugly
        child_process.execSync(
            `cd ${projectFolder}; mv log/debug.log log/bak.log; ${complieCommand} ${filename}; mv log/debug.log log/complie.log ; mv log/bak.log log/debug.log`,
            { shell: '/bin/bash', stdio: 'pipe' }
        );
        return true;
    } catch (e) {
        debug(e);
        return false;
    }
}

const symbolDir = 'log/symbol/';

function loadSymbol(filename: string) {
    if (filename.startsWith('/')) {
        filename = filename.substring(1);
    }
    filename = filename.replace(/\//g, '#');
    const absFilename = path.resolve(projectFolder, symbolDir, filename);
    if (!fs.existsSync(absFilename)) {
        return '';
    }
    return fs.readFileSync(absFilename).toString();
}

enum OP {
    INC = 1,
    DEFINE,
    VAR,
    FUNC,
    NEW,
    POP,
    FREE,
    COMMENT,
}

interface LineSymbol {
    op: OP;
    filename: string;
    lineno: number;
    detail: string;
}

interface ESymbol {
    name: string;
    line: number;
    filename: string;
    args?: string[];
    op?: LineSymbol[];
    detail?: string;
    documentation?: string;
}

interface FileSymbol {
    lineno: number;
    defined: ESymbol[];
    include: ESymbol[];
    variable: ESymbol[];
    func: ESymbol[];
    childFileSymbol: { [key: string]: FileSymbol };
    comment: LineSymbol[];
}

function parse(filename: string, symbolInfo: string) {
    const lineInfo = symbolInfo.split('\n');
    const fileSymbol: FileSymbol = {
        defined: [],
        include: [],
        variable: [],
        func: [],
        childFileSymbol: {},
        lineno: 0,
        comment: [],
    };
    let localArgs: string[] = [];
    let currentLine = 0;
    const hasIncluded = new Set();
    let lastFunction: ESymbol | null = null;

    lineInfo.forEach((line) => {
        if (line.length == 0) return;

        const lineSymbol: LineSymbol = scanf.sscanf(
            line,
            '%d %s %d %S',
            'op',
            'filename',
            'lineno',
            'detail'
        ) as LineSymbol;
        let targetSymbol: FileSymbol | undefined = fileSymbol;

        if (!lineSymbol.detail) lineSymbol.detail = '';

        if (lineSymbol.filename == filename) currentLine = lineSymbol.lineno;

        if (lineSymbol.filename != filename) {
            if (!fileSymbol.childFileSymbol[lineSymbol.filename]) {
                fileSymbol.childFileSymbol[lineSymbol.filename] = {
                    defined: [],
                    include: [],
                    variable: [],
                    func: [],
                    childFileSymbol: {},
                    lineno: lineSymbol.lineno,
                    comment: [],
                };
            }
            targetSymbol = fileSymbol.childFileSymbol[lineSymbol.filename];
        }
        if (targetSymbol) {
            switch (lineSymbol.op) {
                case OP.INC:
                    if (!hasIncluded.has(lineSymbol.filename)) {
                        fileSymbol.include.push({
                            name: lineSymbol.filename,
                            line: currentLine,
                            filename: lineSymbol.filename,
                        });
                        hasIncluded.add(lineSymbol.filename);
                    }
                    break;
                case OP.DEFINE: {
                    let hasArgs = 0;
                    const define = lineSymbol.detail.trim();
                    const spacePos = define.search(`\\s+`);

                    for (let index = 0; index < spacePos; index++) {
                        const element = define[index];
                        if (element == '(') {
                            hasArgs = index;
                            break;
                        }
                    }
                    if (hasArgs) {
                        let right = hasArgs;
                        while (right < define.length && define[right] != ')') right++;
                        let args = define
                            .substring(hasArgs + 1, right)
                            .replace(/,/gi, ' ')
                            .split(' ');
                        args = args.filter(function (value: string) {
                            return value.length > 0;
                        });
                        targetSymbol.defined.push({
                            name: define.substring(0, hasArgs),
                            line: lineSymbol.lineno,
                            args: args,
                            filename: lineSymbol.filename,
                            detail: lineSymbol.detail.substring(right + 1, lineSymbol.detail.length).trim(),
                        });
                    } else {
                        if (spacePos < 0) {
                            targetSymbol.defined.push({
                                name: define,
                                line: lineSymbol.lineno,
                                filename: lineSymbol.filename,
                                detail: undefined,
                            });
                        } else {
                            targetSymbol.defined.push({
                                name: define.substring(0, spacePos),
                                line: lineSymbol.lineno,
                                filename: lineSymbol.filename,
                                detail: lineSymbol.detail.substring(spacePos, lineSymbol.detail.length).trim(),
                            });
                        }
                    }
                    break;

                }
                case OP.VAR:
                    targetSymbol.variable.push({
                        name: lineSymbol.detail,
                        line: lineSymbol.lineno,
                        filename: lineSymbol.filename,
                    });
                    break;
                case OP.FUNC:
                    targetSymbol.func.push({
                        name: lineSymbol.detail,
                        line: lineSymbol.lineno,
                        args: [...localArgs],
                        op: [],
                        filename: lineSymbol.filename,
                    });
                    lastFunction = targetSymbol.func[targetSymbol.func.length - 1];
                    break;
                case OP.NEW:
                    localArgs.push(lineSymbol.detail);
                    if (lastFunction && lastFunction.op) {
                        lastFunction.op.push(lineSymbol);
                    }
                    break;
                case OP.POP: {
                    let n = parseInt(lineSymbol.detail);
                    while (localArgs.length > 0 && n > 0) {
                        localArgs.pop();
                        n--;
                    }
                    if (lastFunction && lastFunction.op) {
                        lastFunction.op.push(lineSymbol);
                    }
                    break;
                }
                case OP.FREE:
                    localArgs = [];
                    if (lastFunction && lastFunction.op) {
                        lastFunction.op.push(lineSymbol);
                    }
                    break;
                case OP.COMMENT:
                    lineSymbol.detail = lineSymbol.detail.trim();
                    targetSymbol.comment.push(lineSymbol);
                    break;
                default:
            }
        }
    });
    attachComment(fileSymbol);
    return fileSymbol;
}

function attachComment(fileSymbol: FileSymbol) {
    for (const file in fileSymbol.childFileSymbol) {
        const childSymbol = fileSymbol.childFileSymbol[file];
        attachComment(childSymbol);
    }
    let idx = 0;
    const commentIdx: { [key: number]: number[] } = {};
    const commentIdx2: { [key: number]: number } = {};

    while (idx < fileSymbol.comment.length) {
        const allidx: number[] = [idx];
        commentIdx2[fileSymbol.comment[idx].lineno] = idx;

        while (idx + 1 < fileSymbol.comment.length && fileSymbol.comment[idx].lineno + 1 == fileSymbol.comment[idx + 1].lineno) {
            idx++;
            allidx.push(idx);
            commentIdx2[fileSymbol.comment[idx].lineno] = idx;
        }
        for (const subidx of allidx) {
            commentIdx[fileSymbol.comment[subidx].lineno] = allidx;
        }
        idx++;
    }
    const all: ESymbol[] = [];
    all.push(...fileSymbol.func);
    all.push(...fileSymbol.variable);
    for (const e of all) {
        const res: string[] = [];

        if (commentIdx[e.line]) {
            for (const idx of commentIdx[e.line]) {
                res.push(fileSymbol.comment[idx].detail);
            }
        }
        if (res.length) {
            res.push('--------------------------------------');
        }
        if (commentIdx[e.line - 1]) {
            for (const idx of commentIdx[e.line - 1]) {
                res.push(fileSymbol.comment[idx].detail);
            }
        }
        res.push('');

        let proto = e.name;
        if (e.args != undefined) {
            let args = "";
            for (let index = 0; index < e.args.length; index++) {
                const arg = e.args[index];
                if (index > 0) {
                    args += ', ';
                }
                args += arg.trim();
            }
            args = '(' + args + ')';
            proto += args;
        }
        res.push(proto);
        e.documentation = res.join('\n');
    }
    for (const e of fileSymbol.defined) {
        const res: string[] = [];

        let proto = e.name;
        if (e.args != undefined) {
            let args = "";
            for (let index = 0; index < e.args.length; index++) {
                const arg = e.args[index];
                if (index > 0) {
                    args += ', ';
                }
                args += arg.trim();
            }
            args = '(' + args + ')';
            proto += args;
        }
        if (commentIdx2[e.line]) {
            res.push(fileSymbol.comment[commentIdx2[e.line]].detail);
            res.push('--------------------------------------');
        }
        if (e.detail) {
            res.push(`#define ${proto} ${e.detail}`);
        }
        e.documentation = res.join('\n');
    }

}

const fileSymbolCache: { [key: string]: FileSymbol } = {};
const fileSymbolCacheTime: { [key: string]: number } = {};

function generateFileSymbol(filename: string): FileSymbol {
    let fileSymbol: FileSymbol = { defined: [], include: [], variable: [], func: [], childFileSymbol: {}, lineno: 0, comment: [] };
    if (filename in fileSymbolCacheTime && Date.now() / 1000 - fileSymbolCacheTime[filename] < 1) {
        return fileSymbolCache[filename];
    }

    if (!complie(filename)) {
        if (filename in fileSymbolCache) return fileSymbolCache[filename];
        return fileSymbol;
    }
    const res = loadSymbol(filename);
    fileSymbol = parse(filename, res);
    fileSymbolCache[filename] = fileSymbol;
    fileSymbolCacheTime[filename] = Date.now() / 1000;
    return fileSymbol;
}

/**
 * for object call function completion
 */
function getDefineFunction(filename: string, line: number, includeChild: boolean): ESymbol[] {
    const ret: ESymbol[] = [];
    const fileSymbol = generateFileSymbol(filename);

    fileSymbol.func.forEach((func) => {
        if (line < 0 || func.line <= line) {
            ret.push(func);
        }
    });

    if (includeChild) {
        for (const file in fileSymbol.childFileSymbol) {
            const childSymbol = fileSymbol.childFileSymbol[file];
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
function getVisibleFunction(filename: string, line: number): ESymbol[] {
    const res = getDefineFunction(filename, line, true);
    efuncObjects.forEach((efuncFile) => {
        res.push(...getDefineFunction(prettyFilename(efuncFile), -1, true));
    });
    return res;
}

function getMacroDefine(filename: string, line: number, includeChild: boolean): ESymbol[] {
    const ret: ESymbol[] = [];
    const fileSymbol = generateFileSymbol(filename);

    fileSymbol.defined.forEach((defined) => {
        if (line < 0 || defined.line <= line) {
            ret.push(defined);
        }
    });

    if (includeChild) {
        for (const file in fileSymbol.childFileSymbol) {
            const childSymbol = fileSymbol.childFileSymbol[file];

            if (line < 0 || childSymbol.lineno <= line) {
                ret.push(...childSymbol.defined);
            }
        }
    }
    return ret;
}

function getGlobalVariable(filename: string, line: number, includeChild: boolean): ESymbol[] {
    const ret: ESymbol[] = [];
    const fileSymbol = generateFileSymbol(filename);

    fileSymbol.variable.forEach((variable) => {
        if (line < 0 || variable.line <= line) {
            ret.push(variable);
        }
    });

    if (includeChild) {
        for (const file in fileSymbol.childFileSymbol) {
            const childSymbol = fileSymbol.childFileSymbol[file];

            if (line < 0 || childSymbol.lineno <= line) {
                ret.push(...childSymbol.variable);
            }
        }
    }
    return ret;
}

function getLocalVariable(filename: string, lineAt: number): ESymbol[] {
    let localArgs: ESymbol[] = [];
    const fileSymbol = generateFileSymbol(filename);
    let lastFunction: ESymbol | null = null;

    for (let index = 0; index < fileSymbol.func.length; index++) {
        const func = fileSymbol.func[index];
        if (func.line <= lineAt) {
            lastFunction = func;
        } else {
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

            if (lineSymbol.lineno > lineAt) break;

            switch (lineSymbol.op) {
                case OP.NEW:
                    localArgs.push({
                        name: lineSymbol.detail,
                        line: lineSymbol.lineno,
                        filename: lineSymbol.filename,
                    });
                    break;
                case OP.POP: {
                    let n = parseInt(lineSymbol.detail);
                    while (localArgs.length > 0 && n > 0) {
                        localArgs.pop();
                        n--;
                    }
                    break;
                }
                case OP.FREE:
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

const completionCache: { [key: string]: vscode.CompletionItem[] } = {};
const completionCacheTime: { [key: string]: number } = {};

function provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const line = getLine(document, position.line);
    const lineText = line.substring(0, position.character);
    let reg: RegExp;

    // #include <
    reg = /#include\s+?(<)\w*?$/;
    if (reg.test(lineText)) {
        const result = getFileAndDir(inc);
        return result;
    }

    // #include "
    reg = /#include\s+?(")([\w|/]*?)$/;
    if (reg.test(lineText)) {
        const exec_result = reg.exec(lineText);
        const result: vscode.CompletionItem[] = [];

        if (exec_result) {
            if (exec_result[2].search('/') == -1) result.push(...getFileAndDir(inc));
            const dir = exec_result[2].split('/');
            let target = '';

            dir.pop();
            if (!exec_result[2].startsWith('/')) {
                target = path.resolve(path.dirname(uri2path(document.uri)), ...dir);
            } else {
                target = path.resolve(projectFolder, ...dir);
            }
            result.push(...getFileAndDir(target));
        }
        return result;
    }

    // "cmd/"
    reg = /(")([\w/]*)$/;
    if (reg.test(lineText)) {
        const exec_result = reg.exec(lineText);
        if (exec_result != null) {
            const dir = exec_result[2].split('/');
            dir.pop();
            return getFileAndDir(path.resolve(projectFolder, ...dir));
        }
        return [];
    }

    // object call
    reg = /([\w/".]+|this_object\(\))->\w*$/;
    if (reg.test(lineText)) {
        const exec_result = reg.exec(lineText);
        let file = '';
        if (exec_result == null) return [];
        if (exec_result[1] == 'this_object()') {
            file = `"${getFileRelativePath(document.uri)}"`;
        } else {
            file = exec_result[1];
        }
        if (!file.startsWith('"')) {
            const define = getMacroDefine(getFileRelativePath(document.uri), position.line, true);
            for (let index = 0; index < define.length; index++) {
                const def = define[index];
                if (def.name == exec_result[1] && def.detail) {
                    file = def.detail;
                }
            }
        }
        file = prettyFilename(file.substring(1, file.length - 1));
        const res: vscode.CompletionItem[] = [];
        const allFunction = getDefineFunction(file, -1, true);
        for (let index = 0; index < allFunction.length; index++) {
            const func = allFunction[index];
            res.push({
                label: func.name,
                kind: vscode.CompletionItemKind.Function,
                insertText: new vscode.SnippetString(func.name + makeSnippetPlaceHolderStr(func.args || [])),
                documentation: func.documentation,
            });
        }
        return res;
    }

    if (lineText.endsWith('>')) return [];

    // call this file
    const filename = getFileRelativePath(document.uri);

    if (
        filename in completionCache &&
        filename in completionCacheTime &&
        Date.now() / 1000 - completionCacheTime[filename] < 5
    ) {
        return completionCache[filename];
    }

    const res: vscode.CompletionItem[] = [];
    for (const local of getLocalVariable(filename, position.line)) {
        res.push({
            label: local.name,
            kind: vscode.CompletionItemKind.Variable,
            insertText: local.name,
            documentation: local.documentation,
        });
    }
    for (const func of getVisibleFunction(filename, position.line)) {
        res.push({
            label: func.name,
            kind: vscode.CompletionItemKind.Function,
            insertText: new vscode.SnippetString(func.name + makeSnippetPlaceHolderStr(func.args || [])),
            documentation: func.documentation,
        });
    }
    for (const define of getMacroDefine(filename, position.line, true)) {
        if (define.args) {
            res.push({
                label: define.name,
                kind: vscode.CompletionItemKind.Function,
                insertText: new vscode.SnippetString(define.name + makeSnippetPlaceHolderStr(define.args || [])),
                documentation: define.documentation,
            });
        } else {
            res.push({
                label: define.name,
                kind: vscode.CompletionItemKind.Constant,
                insertText: define.name,
                documentation: define.documentation,
            });
        }
    }
    for (const variable of getGlobalVariable(filename, position.line, true)) {
        res.push({
            label: variable.name,
            kind: vscode.CompletionItemKind.Variable,
            insertText: variable.name,
            documentation: variable.documentation,
        });
    }
    completionCache[filename] = res;
    completionCacheTime[filename] = Date.now() / 1000;
    return res;
}

function makeSnippetPlaceHolderStr(args: string[]): string {
    let res = '';
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (index > 0) {
            res += ', ';
        }
        res += '${' + (index + 1) + ':' + arg.trim() + '}';
    }
    return '(' + res + ')';
}

function prettyFilename(filename: string): string {
    if (filename.startsWith('/')) filename = filename.substring(1);
    if (!filename.endsWith('.c')) filename = filename + '.c';
    return path.resolve('/', ...filename.replace(/\//, ' ').split(' ')).substring(1);
}

function getFileAndDir(dirPath: string): vscode.CompletionItem[] {
    const output: vscode.CompletionItem[] = [];

    if (!fs.existsSync(dirPath)) return output;

    const files = fs.readdirSync(dirPath);

    for (let i = 0; i < files.length; ++i) {
        let filedir = path.join(dirPath, files[i]);
        const stats = fs.statSync(filedir);

        if (stats == null) return [];
        const isFile = stats.isFile();
        const isDir = stats.isDirectory();
        if (isFile && (filedir.search('\\.c') != -1 || filedir.search('\\.h') != -1)) {
            filedir = filedir.replace(dirPath, '').replace(/\\/g, '/').substr(1);
            output.push({ label: filedir, kind: vscode.CompletionItemKind.File, insertText: filedir });
        } else if (isDir) {
            filedir = filedir.replace(dirPath, '').replace(/\\/g, '/').substr(1) + '/';
            if (filedir.substring(0, 1) == '.') continue;
            output.push({
                label: filedir,
                kind: vscode.CompletionItemKind.Folder,
                insertText: filedir.replace('/', ''),
            });
        }
    }
    return output;
}

function getWordRangeAtPosition(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
    const line = getLine(document, position.line);
    const lineNumber = position.line;
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

function searchInLine(line: string, word: string): number {
    const reg = new RegExp(`\\b${word}\\b`);
    if (reg.test(line)) {
        const exec_result = reg.exec(line);
        if (exec_result) {
            return exec_result['index'];
        }
    }
    return 0;
}

const fileContextCache: { [key: string]: string[] } = {};
const fileContextCacheTime: { [key: string]: number } = {};

function getRangeofWordInFileLine(filename: string, line: number, word: string): vscode.Range {
    const res = { start: { line: line, character: 0 }, end: { line: line, character: 0 } };
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
        const linePos = searchInLine(filelines[line], word);
        res.start.character = linePos;
        res.end.character = linePos + word.length;
    }
    return new vscode.Range(new vscode.Position(res.start.line, res.start.character), new vscode.Position(res.end.line, res.end.character));
}

let lastdotcfile = '';
let hoverSymbol: ESymbol | undefined;

function provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
): vscode.ProviderResult<vscode.Definition> {
    const word = document.getText(getWordRangeAtPosition(document, position));
    const lineText = getLine(document, position.line);
    let filename = getFileRelativePath(document.uri);

    hoverSymbol = undefined;
    if (filename.endsWith('.c')) {
        lastdotcfile = filename;
    } else if (filename.endsWith('.h') && lastdotcfile.length) {
        // when deal with .h file, try best find
        filename = lastdotcfile;
    }

    // -> call jump
    let reg = new RegExp(`([\\w\\/\\"\\.]+|this_object\\(\\))->${word.replace(/\//g, '\\/')}\\(`, 'g');
    let exec_result = reg.exec(lineText);
    do {
        if (
            exec_result != null &&
            exec_result[1] != null &&
            exec_result['index'] + exec_result[1].length + 2 <= position.character &&
            exec_result['index'] + exec_result[1].length + word.length >= position.character - 1
        ) {
            let from = '';

            if (exec_result[1] == 'this_object()') {
                from = `"${getFileRelativePath(document.uri)}"`;
            } else {
                from = exec_result[1];
            }

            if (!from.startsWith('"')) {
                const define = getMacroDefine(filename, position.line, true);
                for (let index = 0; index < define.length; index++) {
                    const def = define[index];
                    if (def.name == from && def.detail) {
                        from = def.detail;
                        break;
                    }
                }
            }

            if (!from.startsWith('"') || !from.endsWith('"')) return;
            from = prettyFilename(from.substring(1, from.length - 1));
            if (!fs.existsSync(path.resolve(projectFolder, from))) return;
            const definefunc = getDefineFunction(from, -1, true);
            for (let index = 0; index < definefunc.length; index++) {
                const func = definefunc[index];
                if (func.name == word) {
                    hoverSymbol = func;
                    return {
                        uri: vscode.Uri.file(path.resolve(projectFolder, func.filename)),
                        range: getRangeofWordInFileLine(path.resolve(projectFolder, func.filename), func.line - 1, func.name),
                    };
                }
            }
            return;
        }

        exec_result = reg.exec(lineText);
    } while (exec_result != null);

    // #include <
    reg = /#include\s+?<([\w|/|.]+)*?>(\s+)?/;
    if (reg.test(lineText)) {
        const exec_result = reg.exec(lineText);
        if (exec_result) {
            const uri = path.resolve(inc, exec_result[1]);
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
    reg = /#include\s+?"([\w|/|.]+)*?"(\s+)?/;
    if (reg.test(lineText)) {
        const exec_result = reg.exec(lineText);

        if (exec_result) {
            let target = exec_result[1];
            if (!target.startsWith('/')) {
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
            } else {
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
    if (word.search(/\//) != -1) {
        const target = prettyFilename(word);
        return {
            uri: vscode.Uri.file(path.resolve(projectFolder, target)),
            range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
        };
    }

    for (const local of getLocalVariable(filename, position.line)) {
        if (local.name == word) {
            hoverSymbol = local;
            return {
                uri: document.uri,
                range: getRangeofWordInFileLine(uri2path(document.uri), local.line - 1, local.name),
            };
        }
    }

    for (const variable of getGlobalVariable(filename, position.line, true)) {
        if (variable.name == word) {
            hoverSymbol = variable;
            return {
                uri: vscode.Uri.file(path.resolve(projectFolder, variable.filename)),
                range: getRangeofWordInFileLine(path.resolve(projectFolder, variable.filename), variable.line - 1, variable.name),
            };
        }
    }

    for (const func of getDefineFunction(filename, position.line, true)) {
        if (func.name == word) {
            hoverSymbol = func;
            return {
                uri: vscode.Uri.file(path.resolve(projectFolder, func.filename)),
                range: getRangeofWordInFileLine(path.resolve(projectFolder, func.filename), func.line - 1, func.name),
            };
        }
    }

    for (let index = 0; index < efuncObjects.length; index++) {
        const efuncFile = efuncObjects[index];
        for (const func of getDefineFunction(efuncFile, -1, true)) {
            if (func.name == word) {
                hoverSymbol = func;
                return {
                    uri: vscode.Uri.file(path.resolve(projectFolder, func.filename)),
                    range: getRangeofWordInFileLine(path.resolve(projectFolder, func.filename), func.line - 1, func.name),
                };
            }
        }
    }

    for (const define of getMacroDefine(filename, position.line, true)) {
        if (define.name == word) {
            hoverSymbol = define;
            return {
                uri: vscode.Uri.file(path.resolve(projectFolder, define.filename)),
                range: getRangeofWordInFileLine(path.resolve(projectFolder, define.filename), define.line - 1, define.name),
            };
        }
    }
    return null;
}

function provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const filename = getFileRelativePath(document.uri);

    const output: vscode.DocumentSymbol[] = [];

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

function provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
): vscode.ProviderResult<vscode.Hover> {
    provideDefinition(document, position);
    if (hoverSymbol && hoverSymbol.documentation) {
        return { contents: [new vscode.MarkdownString(hoverSymbol.documentation)] };
    }
}

export function activate(context: vscode.ExtensionContext) {
    initProjectFolder(context);
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider({ language: "lpc", scheme: "file" }, { provideCompletionItems, }, "/", ">", "<"),
        vscode.languages.registerDefinitionProvider({ language: "lpc", scheme: "file" }, { provideDefinition }),
        vscode.languages.registerDocumentSymbolProvider({ language: "lpc", scheme: "file" }, { provideDocumentSymbols }),
        vscode.languages.registerHoverProvider([{ language: 'lpc' }], { provideHover })
    );
}

export function deactivate() {
    debug("lpcd deactivate");
}
