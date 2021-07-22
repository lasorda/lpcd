# coc-lpcd


解析lpc([语法定义](https://github.com/antlr/grammars-v4/tree/master/lpc))引擎生成的符号表，提供符号跳转和自动补全的功能。

## 安装

`:CocInstall coc-lpcd`

## 依赖
需要提供一个编译程序`lpc_complie`，coc-lpcd使用`lpc_complie cmd/command.c`，在lpc脚本的根目录`project`，将指定的lpc文件编译。在`project/log/symbol/`下生成符号文件，命名为`cmd#command.c`，将/替换为#。

符号文件的格式为
```g4
File:
    : Lines
Lines
    : Line
    | Line Newline Lines
Line:
    : Op ' ' Filename ' ' Lineno ' ' Detail
    ;
Newline
    : '\n'
    ;
Op
    : '1'
    | '2'
    | '3'
    | '4' 
    | '5'
    | '6'
    | '7'
Filename
    : [a-zA-Z0-9_/.]+
Lineno
    : [0-9]+
Detail
    : .*?
```
符号文件由多行组成，每一行是一个操作，每个操作可能是

|操作|解释|内容detail|钩子位置
|:----:|:----:|:----:|:----:
|1|include文件|可以空缺|handle_include
|2|define宏|define内容|handle_define
|3|定义全局变量|变量名|define_new_variable
|4|函数定义|函数名|define_new_function
|5|定义局部变量|变量名|add_local_name
|6|取消局部变量定义|取消个数|pop_n_locals
|7|取消所有的局部变量定义|无|free_all_local_names

文件名和行号来自于yacc解析过程中的`current_file`和`current_line`。

## 配置
```json
{
    "coc-lpcd.efunc": [
        "/etc/efun_define.c",
        "/sys/object/simul_efun.c"
    ],
    "coc-lpcd.include": "inc",
    "coc-lpcd.workspace": "newtxii",
    "coc-lpcd.complie": "lpc_complie"
}
```
1. coc-lpcd.efunc: 这里面定义的函数，任何一个脚本都能访问。
2. coc-lpcd.include: #include <incfile>查找的目录。
3. coc-lpcd.workspace: 确定根目录`project`的目录名。
4. coc-lpcd.complie: 生成符号文件的命令。

## 代码细节
代码核心部分是个parse函数，传入指定的文件，对编译之后的符号文件进行解析生成`FileSymbol`
```ts
interface FileSymbol {
    lineno: number;
    defined: Symbol[],
    include: Symbol[],
    variable: Symbol[],
    func: Symbol[],
    childFileSymbol: { [key: string]: FileSymbol },
}

interface Symbol {
    name: string,
    line: number,
    filename: string,
    args?: string[],
    op?: LineSymbol[],
    detail?: string,
}
```

一个文件符号表用FileSymbol，里面包括该文件定义的宏、全局变量、函数。childFileSymbol用于存放include文件的符号表。lineno是include的行数，用于筛选符号定义之前的代码提示。

每一个符号用Symbol表示，可以是宏定义、函数名、全局变量名。包括符号名、定义的行号、定义的文件名、符号携带的参数（只有宏和函数有）和具体内容（宏内容）。

函数定义之前会先定义局部函数变量，开始函数定义的时候，取出所有的局部变量，就是函数变量。

取消局部变量定义的时候，根据数量，从栈里面弹出即可。

释放所有局部变量的时候，清空局部变量栈。

记录最后一个定义的函数符号，将和局部变量的相关的操作全部加入到队列中，在释放所有局部变量的时候，将队列挂到符号的op中。在进行局部变量名提示的时候，根据当前行号找到函数符号，回放队列中的操作，直到当前行，此时队列中剩余的局部变量，就是可以访问的局部变量名。

> This extension is built with [create-coc-extension](https://github.com/fannheyward/create-coc-extension)