// *****************************************************************************
// Copyright (C) 2020 Ericsson and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { inject, injectable, named } from 'inversify';
import {
    screen, app, BrowserWindow, WebContents, Event as ElectronEvent, BrowserWindowConstructorOptions, nativeImage,
    nativeTheme, shell, dialog
} from '../../electron-shared/electron';
import * as path from 'path';
import { Argv } from 'yargs';
import { AddressInfo } from 'net';
import { promises as fs } from 'fs';
import { existsSync, mkdirSync } from 'fs-extra';
import { fork, ForkOptions } from 'child_process';
import { DefaultTheme, ElectronFrontendApplicationConfig, FrontendApplicationConfig } from '@theia/application-package/lib/application-props';
import URI from '../common/uri';
import { FileUri } from '../common/file-uri';
import { Deferred, timeout } from '../common/promise-util';
import { MaybePromise } from '../common/types';
import { ContributionProvider } from '../common/contribution-provider';
import { ElectronSecurityTokenService } from './electron-security-token-service';
import { ElectronSecurityToken } from '../electron-common/electron-token';
import Storage = require('electron-store');
import { CancellationTokenSource, Disposable, DisposableCollection, Path, isOSX, isWindows } from '../common';
import { DEFAULT_WINDOW_HASH, WindowSearchParams } from '../common/window';
import { TheiaBrowserWindowOptions, TheiaElectronWindow, TheiaElectronWindowFactory } from './theia-electron-window';
import { ElectronMainApplicationGlobals } from './electron-main-constants';
import { createDisposableListener } from './event-utils';
import { TheiaRendererAPI } from './electron-api-main';
import { StopReason } from '../common/frontend-application-state';
import { dynamicRequire } from '../node/dynamic-require';

export { ElectronMainApplicationGlobals };

const createYargs: (argv?: string[], cwd?: string) => Argv = require('yargs/yargs');


/**
 * 定义了 Electron 主进程命令的选项
 */
export interface ElectronMainCommandOptions {
    /**
     * 默认情况下，第一个位置参数。应该是一个相对或绝对文件系统路径，指向一个文件或文件夹。
     */
    readonly file?: string;

    /**
     * 当前工作目录。
     */
    readonly cwd: string;

    /**
     * 如果应用程序是第一次启动，则 `secondInstance` 为 false。
     * 如果应用程序已经在运行，但用户重新启动它，则 `secondInstance` 为 true。
     */
    readonly secondInstance: boolean;
}


/**
 * The default entrypoint will handle a very rudimentary CLI to open workspaces by doing `app path/to/workspace`. To override this behavior, you can extend and rebind the
 * `ElectronMainApplication` class and overriding the `launch` method.
 * A JSON-RPC communication between the Electron Main Process and the Renderer Processes is available: You can bind services using the `ElectronConnectionHandler` and
 * `ElectronIpcConnectionProvider` APIs, example:
 *
 * From an `electron-main` module:
 *
 *     bind(ElectronConnectionHandler).toDynamicValue(context =>
 *          new RpcConnectionHandler(electronMainWindowServicePath,
 *          () => context.container.get(ElectronMainWindowService))
 *     ).inSingletonScope();
 *
 * And from the `electron-browser` module:
 *
 *     bind(ElectronMainWindowService).toDynamicValue(context =>
 *          ElectronIpcConnectionProvider.createProxy(context.container, electronMainWindowServicePath)
 *     ).inSingletonScope();
 */
/**
 * 定义了一个符号，用于标识 Electron 主应用程序贡献
 */
export const ElectronMainApplicationContribution = Symbol('ElectronMainApplicationContribution');

/**
 * 定义了 Electron 主应用程序贡献的接口
 * 该接口包含了应用程序启动和停止时的回调方法
 */
export interface ElectronMainApplicationContribution {
    /**
     * 当应用程序启动时调用的方法
     * 这是初始化全局服务的时机
     * 该方法在 Electron 主进程首次启动时调用
     * @param application - 应用程序实例
     */
    onStart?(application: ElectronMainApplication): MaybePromise<void>;

    /**
     * 当应用程序停止时调用的方法
     * 贡献必须执行同步操作
     * @param application - 应用程序实例
     */
    onStop?(application: ElectronMainApplication): void;
}


// Extracted and modified the functionality from `yargs@15.4.0-beta.0`.
// Based on https://github.com/yargs/yargs/blob/522b019c9a50924605986a1e6e0cb716d47bcbca/lib/process-argv.ts
/**
 * 定义了一个可注入的类，用于处理 Electron 主进程的命令行参数
 */
@injectable()
export class ElectronMainProcessArgv {
    /**
     * 获取进程参数中二进制文件索引的方法
     * @returns 二进制文件在进程参数中的索引
     */
    protected get processArgvBinIndex(): number {
        // 如果是打包的 Electron 应用程序，二进制文件名是命令行参数的第一个参数
        if (this.isBundledElectronApp) {
            return 0;
        }
        // 否则，对于标准的 Node.js 应用程序或未打包的 Electron 应用程序，二进制文件名是命令行参数的第二个参数
        return 1;
    }

    /**
     * 判断当前应用程序是否为打包的 Electron 应用程序
     * @returns 如果是打包的 Electron 应用程序，返回 true；否则返回 false
     */
    get isBundledElectronApp(): boolean {
        // process.defaultApp 是由 Electron 设置的，在未打包的 Electron 应用程序中为 undefined
        // 详情请参见 https://github.com/electron/electron/blob/master/docs/api/process.md#processdefaultapp-readonly
        return this.isElectronApp && !(process as ElectronMainProcessArgv.ElectronMainProcess).defaultApp;
    }

    /**
     * 判断当前应用程序是否为 Electron 应用程序
     * @returns 如果是 Electron 应用程序，返回 true；否则返回 false
     */
    get isElectronApp(): boolean {
        // process.versions.electron 是由 Electron 设置的，在非 Electron 应用程序中为 undefined
        // 详情请参见 https://github.com/electron/electron/blob/master/docs/api/process.md#processversionselectron-readonly
        return !!(process as ElectronMainProcessArgv.ElectronMainProcess).versions.electron;
    }

    /**
     * 获取去除二进制文件名后的命令行参数数组
     * @param argv - 可选的命令行参数数组，默认为 process.argv
     * @returns 去除二进制文件名后的命令行参数数组
     */
    getProcessArgvWithoutBin(argv = process.argv): Array<string> {
        return argv.slice(this.processArgvBinIndex + 1);
    }

    /**
     * 获取命令行参数中的二进制文件名
     * @param argv - 可选的命令行参数数组，默认为 process.argv
     * @returns 命令行参数中的二进制文件名
     */
    getProcessArgvBin(argv = process.argv): string {
        return argv[this.processArgvBinIndex];
    }
}


/**
 * 定义了一个命名空间，用于扩展 Electron 主进程的属性和方法
 */
export namespace ElectronMainProcessArgv {
    /**
     * 定义了 Electron 主进程的接口，继承自 NodeJS.Process 接口
     * 该接口扩展了 Electron 主进程的属性，包括 defaultApp 和 versions
     */
    export interface ElectronMainProcess extends NodeJS.Process {
        /**
         * 指示当前应用程序是否为默认应用程序
         * 如果是打包的 Electron 应用程序，则该属性为 false
         * 如果是未打包的 Electron 应用程序，则该属性为 undefined
         */
        readonly defaultApp: boolean;
        /**
         * 包含 Node.js 和 Electron 版本信息的对象
         * 该对象扩展了 NodeJS.ProcessVersions 对象，添加了 electron 属性
         */
        readonly versions: NodeJS.ProcessVersions & {
            /**
             * Electron 版本号
             */
            readonly electron: string;
        };
    }
}




@injectable()
export class ElectronMainApplication {
    // 注入 ContributionProvider，用于获取 ElectronMainApplicationContribution 类型的贡献
    @inject(ContributionProvider)
    @named(ElectronMainApplicationContribution)
    protected readonly contributions: ContributionProvider<ElectronMainApplicationContribution>;

    // 注入 ElectronMainApplicationGlobals，用于获取全局配置和状态
    @inject(ElectronMainApplicationGlobals)
    protected readonly globals: ElectronMainApplicationGlobals;

    // 注入 ElectronMainProcessArgv，用于获取和处理 Electron 主进程的命令行参数
    @inject(ElectronMainProcessArgv)
    protected processArgv: ElectronMainProcessArgv;

    // 注入 ElectronSecurityTokenService，用于处理 Electron 安全令牌相关的服务
    @inject(ElectronSecurityTokenService)
    protected electronSecurityTokenService: ElectronSecurityTokenService;

    // 注入 ElectronSecurityToken，用于获取 Electron 安全令牌
    @inject(ElectronSecurityToken)
    protected readonly electronSecurityToken: ElectronSecurityToken;

    // 注入 TheiaElectronWindowFactory，用于创建和管理 Electron 窗口
    @inject(TheiaElectronWindowFactory)
    protected readonly windowFactory: TheiaElectronWindowFactory;

    // 判断当前应用程序是否为便携模式
    protected isPortable = this.makePortable();

    // 创建一个 Electron 存储实例，用于存储窗口状态等信息
    protected readonly electronStore = new Storage<{
        windowstate?: TheiaBrowserWindowOptions
    }>();

    // 创建一个延迟对象，用于存储后端端口号
    protected readonly _backendPort = new Deferred<number>();
    // 暴露后端端口号的 Promise
    readonly backendPort = this._backendPort.promise;

    // 存储前端应用程序配置
    protected _config: FrontendApplicationConfig | undefined;
    // 是否使用原生窗口框架
    protected useNativeWindowFrame: boolean = true;
    // 自定义背景颜色
    protected customBackgroundColor?: string;
    // 记录窗口启动时是否使用了原生窗口框架
    protected didUseNativeWindowFrameOnStart = new Map<number, boolean>();
    // 存储所有窗口实例
    protected windows = new Map<number, TheiaElectronWindow>();
    // 存储活动窗口的 ID 栈
    protected activeWindowStack: number[] = [];
    // 是否正在重启
    protected restarting = false;

    /** Used to temporarily store the reference to an early created main window */
    // 用于临时存储早期创建的主窗口的引用
    protected initialWindow?: BrowserWindow;


    /**
     * 获取前端应用程序配置
     * @throws {Error} 如果应用程序尚未启动，则抛出错误
     * @returns {FrontendApplicationConfig} 前端应用程序配置对象
     */
    get config(): FrontendApplicationConfig {
        // 如果 _config 未定义，则抛出错误
        if (!this._config) {
            throw new Error('You have to start the application first.');
        }
        // 返回 _config
        return this._config;
    }

    /**
   * 判断当前应用是否为便携模式，并进行相应的处理
   * @returns {boolean} 如果应用是便携模式，返回 true，否则返回 false
   */
    protected makePortable(): boolean {
        // 获取应用程序的数据文件夹路径
        const dataFolderPath = path.join(app.getAppPath(), 'data');
        // 获取应用程序的数据文件夹中的 app-data 路径
        const appDataPath = path.join(dataFolderPath, 'app-data');
        // 如果数据文件夹存在
        if (existsSync(dataFolderPath)) {
            // 如果 app-data 文件夹不存在
            if (!existsSync(appDataPath)) {
                // 创建 app-data 文件夹
                mkdirSync(appDataPath);
            }
            // 设置应用程序的用户数据路径为 app-data 文件夹
            app.setPath('userData', appDataPath);
            // 返回 true，表示应用是便携模式
            return true;
        } else {
            // 返回 false，表示应用不是便携模式
            return false;
        }
    }

    /**
     * 启动应用程序
     * @param {FrontendApplicationConfig} config - 前端应用程序配置
     * @returns {Promise<void>} 当应用程序启动完成时解决的 Promise
     */
    async start(config: FrontendApplicationConfig): Promise<void> {
        // 获取命令行参数，去除二进制文件名
        const argv = this.processArgv.getProcessArgvWithoutBin(process.argv);
        // 创建一个 yargs 实例，用于处理命令行参数
        createYargs(argv, process.cwd())
            // 禁用帮助信息
            .help(false)
            // 定义一个命令，该命令接受一个文件参数
            .command('$0 [file]', false,
                cmd => cmd
                    // 定义一个选项，用于指定 electron 用户数据区域
                    .option('electronUserData', {
                        type: 'string',
                        describe: 'The area where the electron main process puts its data'
                    })
                    // 定义一个位置参数，用于指定文件路径
                    .positional('file', { type: 'string' }),
                async args => {
                    // 如果指定了 electron 用户数据区域
                    if (args.electronUserData) {
                        // 打印信息，指示正在使用指定的用户数据区域
                        console.info(`using electron user data area : '${args.electronUserData}'`);
                        // 创建指定的用户数据区域
                        await fs.mkdir(args.electronUserData, { recursive: true });
                        // 设置应用程序的用户数据路径
                        app.setPath('userData', args.electronUserData);
                    }
                    // 根据配置确定是否使用原生窗口框架
                    this.useNativeWindowFrame = this.getTitleBarStyle(config) === 'native';
                    // 保存前端应用程序配置
                    this._config = config;
                    // 挂载应用程序事件
                    this.hookApplicationEvents();
                    // 显示初始窗口  
                    this.showInitialWindow(argv.includes('--open-url') ? argv[argv.length - 1] : undefined);
                    // 启动后端服务，并获取后端端口号
                    const port = await this.startBackend();
                    // 解析后端端口号
                    this._backendPort.resolve(port);
                    // 等待应用程序就绪
                    await app.whenReady();
                    // 附加电子安全令牌
                    await this.attachElectronSecurityToken(port);
                    // 启动贡献
                    await this.startContributions();

                    // 处理主命令
                    this.handleMainCommand({
                        file: args.file,
                        cwd: process.cwd(),
                        secondInstance: false
                    });
                },
            ).parse();
    }


    /**
     * 获取标题栏样式
     * @param config - 前端应用程序配置
     * @returns 'native' 或 'custom'
     */
    protected getTitleBarStyle(config: FrontendApplicationConfig): 'native' | 'custom' {
        // 如果环境变量 THEIA_ELECTRON_DISABLE_NATIVE_ELEMENTS 被设置为 1，则返回 'custom'
        if ('THEIA_ELECTRON_DISABLE_NATIVE_ELEMENTS' in process.env && process.env.THEIA_ELECTRON_DISABLE_NATIVE_ELEMENTS === '1') {
            return 'custom';
        }
        // 如果是 macOS，则返回 'native'
        if (isOSX) {
            return 'native';
        }
        // 从 electronStore 中获取 windowstate 中的 frame 值
        const storedFrame = this.electronStore.get('windowstate')?.frame;
        // 如果 storedFrame 存在，则根据其值返回 'native' 或 'custom'
        if (storedFrame !== undefined) {
            return !!storedFrame ? 'native' : 'custom';
        }
        // 如果 config.preferences 中存在 window.titleBarStyle，则返回其值
        if (config.preferences && config.preferences['window.titleBarStyle']) {
            const titleBarStyle = config.preferences['window.titleBarStyle'];
            // 如果 titleBarStyle 是 'native' 或 'custom'，则返回其值
            if (titleBarStyle === 'native' || titleBarStyle === 'custom') {
                return titleBarStyle;
            }
        }
        // 如果是 Windows，则返回 'custom'，否则返回 'native'
        return isWindows ? 'custom' : 'native';
    }

    /**
     * 设置标题栏样式
     * @param webContents - 网页内容对象
     * @param style - 标题栏样式，'native' 或 'custom'
     */
    public setTitleBarStyle(webContents: WebContents, style: string): void {
        // 根据 style 的值设置 useNativeWindowFrame 的值
        this.useNativeWindowFrame = isOSX || style === 'native';
        // 保存窗口状态
        this.saveState(webContents);
    }

    /**
     * 设置背景颜色
     * @param webContents - 网页内容对象
     * @param backgroundColor - 背景颜色
     */
    setBackgroundColor(webContents: WebContents, backgroundColor: string): void {
        // 设置 customBackgroundColor 的值
        this.customBackgroundColor = backgroundColor;
        // 保存窗口状态
        this.saveState(webContents);
    }

    /**
     * 保存窗口状态
     * @param webContents - 网页内容对象
     */
    protected saveState(webContents: Electron.WebContents): void {
        // 从 webContents 中获取 BrowserWindow 对象
        const browserWindow = BrowserWindow.fromWebContents(webContents);
        // 如果 browserWindow 存在，则保存窗口状态
        if (browserWindow) {
            this.saveWindowState(browserWindow);
        } else {
            // 如果 browserWindow 不存在，则打印警告信息
            console.warn(`no BrowserWindow with id: ${webContents.id}`);
        }
    }

    /**
     * 获取启动时的标题栏样式
     * @param webContents - 网页内容对象
     * @returns 'native' 或 'custom'
     */
    getTitleBarStyleAtStartup(webContents: WebContents): 'native' | 'custom' {
        // 从 didUseNativeWindowFrameOnStart 中获取 webContents.id 对应的标题栏样式
        return this.didUseNativeWindowFrameOnStart.get(webContents.id) ? 'native' : 'custom';
    }

    /**
     * 确定启动画面的边界
     * @param initialWindowBounds - 初始窗口的边界
     * @returns 启动画面的边界
     */
    protected async determineSplashScreenBounds(initialWindowBounds: { x: number, y: number, width: number, height: number }):
        Promise<{ x: number, y: number, width: number, height: number }> {
        // 获取启动画面的配置选项
        const splashScreenOptions = this.getSplashScreenOptions();
        // 如果 splashScreenOptions 存在，则获取其宽度和高度，否则使用默认值 640x480
        const width = splashScreenOptions?.width ?? 640;
        const height = splashScreenOptions?.height ?? 480;

        // 通过窗口的中心点确定显示启动画面的屏幕
        const windowCenterPoint = { x: initialWindowBounds.x + (initialWindowBounds.width / 2), y: initialWindowBounds.y + (initialWindowBounds.height / 2) };
        const { bounds } = screen.getDisplayNearestPoint(windowCenterPoint);

        // 将启动画面放置在屏幕的中心
        const screenCenterPoint = { x: bounds.x + (bounds.width / 2), y: bounds.y + (bounds.height / 2) };
        const x = screenCenterPoint.x - (width / 2);
        const y = screenCenterPoint.y - (height / 2);

        return {
            x, y, width, height
        };
    }

    /**
     * 判断是否提前显示窗口
     * @returns true 或 false
     */
    protected isShowWindowEarly(): boolean {
        // 如果 config.electron.showWindowEarly 为 true，且环境变量 THEIA_ELECTRON_NO_EARLY_WINDOW 未被设置为 1，则返回 true
        return !!this.config.electron.showWindowEarly &&
            !('THEIA_ELECTRON_NO_EARLY_WINDOW' in process.env && process.env.THEIA_ELECTRON_NO_EARLY_WINDOW === '1');
    }

    /**
     * 显示初始窗口
     * @param urlToOpen - 要打开的 URL
     */
    protected showInitialWindow(urlToOpen: string | undefined): void {
        // 如果 isShowWindowEarly() 或 isShowSplashScreen() 返回 true
        if (this.isShowWindowEarly() || this.isShowSplashScreen()) {
            // 当应用程序准备就绪时
            app.whenReady().then(async () => {
                // 获取最后一个窗口的选项
                const options = await this.getLastWindowOptions();
                // 如果我们想要显示一个启动画面，则不要自动打开主窗口
                if (this.isShowSplashScreen()) {
                    options.preventAutomaticShow = true;
                }
                console.log(`窗口配置内容:${JSON.stringify(options)}`)
                // 创建初始窗口
                this.initialWindow = await this.createWindow({ ...options });

                // 监听应用程序状态的变化
                TheiaRendererAPI.onApplicationStateChanged(this.initialWindow.webContents, state => {
                    // 如果状态为 'ready'，并且 urlToOpen 存在，则打开 URL
                    if (state === 'ready' && urlToOpen) {
                        this.openUrl(urlToOpen);
                    }
                });
                // 如果 isShowSplashScreen() 返回 true，则配置并显示启动画面
                if (this.isShowSplashScreen()) {
                    console.log('Showing splash screen');
                    this.configureAndShowSplashScreen(this.initialWindow);
                }

                // 如果 isShowWindowEarly() 返回 true，并且没有配置启动画面，则提前显示主窗口
                if (this.isShowWindowEarly() && !this.isShowSplashScreen()) {
                    console.log('Showing main window early');
                    this.initialWindow.show();
                }
            });
        }
    }



    /**
 * 配置并显示启动画面
 * @param mainWindow - 主窗口对象
 * @returns 启动画面窗口对象
 */
    protected async configureAndShowSplashScreen(mainWindow: BrowserWindow): Promise<BrowserWindow> {
        // 获取启动画面的配置选项，如果不存在则返回 undefined
        const splashScreenOptions = this.getSplashScreenOptions()!;
        // 打印调试信息，显示启动画面的配置选项
        console.debug('SplashScreen options', splashScreenOptions);

        // 确定启动画面的边界，根据主窗口的边界计算得出
        const splashScreenBounds = await this.determineSplashScreenBounds(mainWindow.getBounds());

        // 创建一个新的 BrowserWindow 实例作为启动画面窗口
        const splashScreenWindow = new BrowserWindow({
            // 设置启动画面窗口的边界
            ...splashScreenBounds,
            // 窗口无边框
            frame: false,
            // 窗口始终在最顶层
            alwaysOnTop: true,
            // 窗口初始时不显示
            show: false,
            // 窗口透明
            transparent: true,
            // 网页偏好设置
            webPreferences: {
                // 背景节流：false
                backgroundThrottling: false,
                // 允许开发者工具
                devTools: true
            }
        });


        // 根据配置选项决定是否立即显示启动画面窗口
        if (this.isShowWindowEarly()) {
            console.log('Showing splash screen early');
            // 立即显示启动画面窗口
            splashScreenWindow.show();
        } else {
            // 监听启动画面窗口的 'ready-to-show' 事件
            splashScreenWindow.on('ready-to-show', () => {
                // 显示启动画面窗口
                splashScreenWindow.show();
            });
        }

        // 加载启动画面的内容文件
        splashScreenWindow.loadFile(path.resolve(this.globals.THEIA_APP_PROJECT_PATH, splashScreenOptions.content!).toString());

        // 关闭启动画面并显示主窗口，当前端准备就绪或达到最大等待时间时执行
        const cancelTokenSource = new CancellationTokenSource();
        const minTime = timeout(splashScreenOptions.minDuration ?? 0, cancelTokenSource.token);
        const maxTime = timeout(splashScreenOptions.maxDuration ?? 30000, cancelTokenSource.token);

        const showWindowAndCloseSplashScreen = () => {
            cancelTokenSource.cancel();
            if (!mainWindow.isVisible()) {
                // 显示主窗口
                mainWindow.show();
            }
            // 关闭启动画面窗口
            splashScreenWindow.close();
        };

        // 监听应用程序状态变化，当状态变为 'ready' 时执行相应操作
        TheiaRendererAPI.onApplicationStateChanged(mainWindow.webContents, state => {
            if (state === 'ready') {
                // 在最短时间后显示主窗口并关闭启动画面
                minTime.then(() => showWindowAndCloseSplashScreen());
            }
        });

        // 在最长时间后显示主窗口并关闭启动画面
        maxTime.then(() => showWindowAndCloseSplashScreen());

        // 返回启动画面窗口实例
        return splashScreenWindow;
    }


    /**
     * 判断是否显示启动画面
     * @returns {boolean} 如果显示启动画面，返回 true，否则返回 false
     */
    protected isShowSplashScreen(): boolean {
        // 检查 config.electron.splashScreenOptions 是否为对象且 content 属性存在
        return typeof this.config.electron.splashScreenOptions === 'object' &&
            !!this.config.electron.splashScreenOptions.content;
    }

    /**
     * 获取启动画面的配置选项
     * @returns {ElectronFrontendApplicationConfig.SplashScreenOptions | undefined} 启动画面的配置选项，如果没有配置，则返回 undefined
     */
    protected getSplashScreenOptions(): ElectronFrontendApplicationConfig.SplashScreenOptions | undefined {
        // 如果 isShowSplashScreen() 返回 true，则返回 splashScreenOptions
        if (this.isShowSplashScreen()) {
            return this.config.electron.splashScreenOptions;
        }
        // 否则返回 undefined
        return undefined;
    }


    /**
     * 创建一个新的窗口
     * @param asyncOptions - 窗口的配置选项，可以是一个 Promise，它会解析为 TheiaBrowserWindowOptions 类型的对象
     * @returns 新创建的窗口对象
     */
    async createWindow(asyncOptions: MaybePromise<TheiaBrowserWindowOptions> = this.getDefaultTheiaWindowOptions()): Promise<BrowserWindow> {
        // 等待异步选项解析，得到窗口的配置选项
        let options = await asyncOptions;
        // 避免窗口重叠
        options = this.avoidOverlap(options);
        // 使用配置选项和应用程序配置创建一个新的 Electron 窗口
        const electronWindow = this.windowFactory(options, this.config);
        // 获取窗口的 ID
        const id = electronWindow.window.webContents.id;
        // 将窗口 ID 推入活动窗口栈，表示该窗口是当前活动的窗口之一
        this.activeWindowStack.push(id);
        // 将窗口 ID 和对应的 Electron 窗口实例添加到 windows 映射中，以便后续管理
        this.windows.set(id, electronWindow);

        // 设置窗口关闭事件监听器，当窗口关闭时，从活动窗口栈和窗口映射中移除该窗口的 ID 和实例
        electronWindow.onDidClose(() => {
            const stackIndex = this.activeWindowStack.indexOf(id);
            if (stackIndex >= 0) {
                this.activeWindowStack.splice(stackIndex, 1);
            }
            this.windows.delete(id);
        });

        // 设置窗口最大化和取消最大化事件监听器，并通过 TheiaRendererAPI 将这些事件发送到渲染器进程
        electronWindow.window.on('maximize', () => TheiaRendererAPI.sendWindowEvent(electronWindow.window.webContents, 'maximize'));
        electronWindow.window.on('unmaximize', () => TheiaRendererAPI.sendWindowEvent(electronWindow.window.webContents, 'unmaximize'));

        // 设置窗口焦点事件监听器，当窗口获得焦点时，更新活动窗口栈，并通过 TheiaRendererAPI 将焦点事件发送到渲染器进程
        electronWindow.window.on('focus', () => {
            const stackIndex = this.activeWindowStack.indexOf(id);
            if (stackIndex >= 0) {
                this.activeWindowStack.splice(stackIndex, 1);
            }
            this.activeWindowStack.unshift(id);
            TheiaRendererAPI.sendWindowEvent(electronWindow.window.webContents, 'focus');
        });

        // 为窗口附加一个监听器，用于在窗口状态改变时保存窗口的位置和大小
        this.attachSaveWindowState(electronWindow.window);

        // 返回新创建的窗口实例
        return electronWindow.window;
    }



    /**
     * 获取最后一个窗口的配置选项
     * @returns {Promise<TheiaBrowserWindowOptions>} 窗口的配置选项
     */
    async getLastWindowOptions(): Promise<TheiaBrowserWindowOptions> {
        // 从 electronStore 中获取之前的窗口状态
        const previousWindowState: TheiaBrowserWindowOptions | undefined = this.electronStore.get('windowstate');
        // 如果之前的窗口状态存在，并且其 screenLayout 与当前的屏幕布局相同，则使用之前的窗口状态
        const windowState = previousWindowState?.screenLayout === this.getCurrentScreenLayout()
            ? previousWindowState
            : this.getDefaultTheiaWindowOptions();
        // 返回一个包含默认选项和之前窗口状态的新对象
        return {
            frame: this.useNativeWindowFrame,
            ...this.getDefaultOptions(),
            ...windowState
        };
    }


    /**
     * 避免窗口重叠
     * @param options - 窗口的配置选项
     * @returns 调整后的窗口配置选项
     */
    protected avoidOverlap(options: TheiaBrowserWindowOptions): TheiaBrowserWindowOptions {
        // 获取所有已存在窗口的边界
        const existingWindowsBounds = BrowserWindow.getAllWindows().map(window => window.getBounds());
        // 如果存在已存在的窗口
        if (existingWindowsBounds.length > 0) {
            // 当新窗口的 x 或 y 坐标与已存在窗口的 x 或 y 坐标相同时，循环调整新窗口的位置
            while (existingWindowsBounds.some(window => window.x === options.x || window.y === options.y)) {
                // 如果窗口是最大化或全屏的，使用默认窗口选项
                if (options.isMaximized || options.isFullScreen) {
                    options = this.getDefaultTheiaWindowOptions();
                }
                // 每次循环将新窗口的 x 和 y 坐标增加 30
                options.x = options.x! + 30;
                options.y = options.y! + 30;
            }
        }
        // 返回调整后的窗口配置选项
        return options;
    }


    /**
     * 获取默认窗口选项
     * @returns {TheiaBrowserWindowOptions} 默认窗口选项
     */
    protected getDefaultOptions(): TheiaBrowserWindowOptions {
        return {
            // 窗口初始化时不显示
            show: false,
            // 窗口标题，从配置中获取应用程序名称
            title: this.config.applicationName,
            // 窗口背景颜色，根据配置中的 darkTheme 选项或系统主题来确定
            backgroundColor: DefaultTheme.defaultBackgroundColor(this.config.electron.windowOptions?.darkTheme || nativeTheme.shouldUseDarkColors),
            // 窗口最小宽度
            minWidth: 200,
            // 窗口最小高度
            minHeight: 120,
            // WebPreferences 配置
            webPreferences: {
                // 启用上下文隔离
                contextIsolation: true,
                // 禁用沙箱
                sandbox: false,
                // 禁用 Node.js 集成
                nodeIntegration: false,
                // 禁用 Web Workers 中的 Node.js 集成
                nodeIntegrationInWorker: false,
                // 禁用后台节流
                backgroundThrottling: false,
                // 预加载脚本路径
                preload: path.resolve(this.globals.THEIA_APP_PROJECT_PATH, 'lib', 'frontend', 'preload.js').toString()
            },
            // 合并配置中的 electron.windowOptions
            ...this.config.electron?.windowOptions || {},
        };
    }

    /**
     * 打开默认窗口
     * @param params - 窗口搜索参数
     * @returns {Promise<BrowserWindow>} 新打开的窗口对象
     */
    async openDefaultWindow(params?: WindowSearchParams): Promise<BrowserWindow> {
        // 获取默认窗口选项
        const options = this.getDefaultTheiaWindowOptions();
        // 并发创建窗口 URI 和重用或创建窗口
        const [uri, electronWindow] = await Promise.all([this.createWindowUri(params), this.reuseOrCreateWindow(options)]);
        // 加载 URL 到窗口中，使用默认窗口哈希作为片段
        electronWindow.loadURL(uri.withFragment(DEFAULT_WINDOW_HASH).toString(true));
        // 返回新打开的窗口对象
        return electronWindow;
    }

    /**
     * 使用工作区路径打开窗口
     * @param workspacePath - 工作区路径
     * @returns {Promise<BrowserWindow>} 新打开的窗口对象
     */
    protected async openWindowWithWorkspace(workspacePath: string): Promise<BrowserWindow> {
        // 获取最后一个窗口的配置选项
        const options = await this.getLastWindowOptions();
        // 并发创建窗口 URI 和重用或创建窗口
        const [uri, electronWindow] = await Promise.all([this.createWindowUri(), this.reuseOrCreateWindow(options)]);
        // 加载 URL 到窗口中，使用工作区路径作为片段
        electronWindow.loadURL(uri.withFragment(encodeURI(workspacePath)).toString(true));
        // 返回新打开的窗口对象
        return electronWindow;
    }

    /**
   * 尝试重用或创建一个新的窗口
   * @param asyncOptions - 窗口的配置选项，可以是一个 Promise，它会解析为 TheiaBrowserWindowOptions 类型的对象
   * @returns 新创建的窗口对象
   */
    protected async reuseOrCreateWindow(asyncOptions: MaybePromise<TheiaBrowserWindowOptions>): Promise<BrowserWindow> {
        // 如果 initialWindow 不存在，则创建一个新窗口
        if (!this.initialWindow) {
            return this.createWindow(asyncOptions);
        }
        // 重置 initialWindow，使其在被重用一次后变为 undefined
        const window = this.initialWindow;
        this.initialWindow = undefined;
        return window;
    }

    /**
     * "Gently" close all windows, application will not stop if a `beforeunload` handler returns `false`.
     */
    requestStop(): void {
        // 调用 app.quit() 方法来尝试关闭所有窗口
        app.quit();
    }

    /**
     * 处理主命令选项
     * @param options - 主命令选项
     * @returns {Promise<void>} 处理完成的 Promise
     */
    protected async handleMainCommand(options: ElectronMainCommandOptions): Promise<void> {
        // 根据不同的命令选项执行不同的操作
        if (options.secondInstance === false) {
            // 如果不允许第二个实例，则打开之前的工作区
            await this.openWindowWithWorkspace('');
        } else if (options.file === undefined) {
            // 如果没有指定文件，则打开默认窗口
            await this.openDefaultWindow();
        } else {
            let workspacePath: string | undefined;
            try {
                // 尝试将指定的文件路径解析为真实路径
                workspacePath = await fs.realpath(path.resolve(options.cwd, options.file));
            } catch {
                // 如果解析失败，记录错误并回退到默认工作区
                console.error(`Could not resolve the workspace path. "${options.file}" is not a valid 'file' option. Falling back to the default workspace location.`);
            }
            // 根据解析结果决定打开的窗口
            if (workspacePath === undefined) {
                await this.openDefaultWindow();
            } else {
                await this.openWindowWithWorkspace(workspacePath);
            }
        }
    }

    /**
     * 在所有窗口中尝试打开指定的 URL
     * @param url - 要打开的 URL
     * @returns {Promise<void>} 打开操作完成的 Promise
     */
    async openUrl(url: string): Promise<void> {
        // 遍历所有活动窗口的 ID
        for (const id of this.activeWindowStack) {
            // 获取窗口对象
            const window = this.windows.get(id);
            // 如果窗口存在并且成功打开了 URL，则停止循环
            if (window && await window.openUrl(url)) {
                break;
            }
        }
    }

    /**
     * 创建一个窗口 URI
     * @param params - 窗口搜索参数
     * @returns {Promise<URI>} 创建的 URI
     */
    protected async createWindowUri(params: WindowSearchParams = {}): Promise<URI> {
        // 如果参数中没有指定端口，则使用后端端口
        if (!('port' in params)) {
            params.port = (await this.backendPort).toString();
        }
        // 将参数转换为查询字符串
        const query = Object.entries(params).map(([name, value]) => `${name}=${value}`).join('&');
        // 创建一个 URI，指向前端 HTML 文件，并附加查询字符串
        return FileUri.create(this.globals.THEIA_FRONTEND_HTML_PATH)
            .withQuery(query);
    }

    /**
     * 获取默认的 Theia 窗口选项
     * @returns {TheiaBrowserWindowOptions} 默认的窗口选项
     */
    protected getDefaultTheiaWindowOptions(): TheiaBrowserWindowOptions {
        return {
            // 使用原生窗口框架
            frame: this.useNativeWindowFrame,
            // 初始状态不是全屏
            isFullScreen: false,
            // 初始状态不是最大化
            isMaximized: false,
            // 获取默认的 Theia 窗口边界
            ...this.getDefaultTheiaWindowBounds(),
            // 获取默认的窗口选项
            ...this.getDefaultOptions()
        };
    }


    /**
     * 获取默认的 Theia 二级窗口边界
     * @returns {TheiaBrowserWindowOptions} 默认的二级窗口边界选项
     */
    protected getDefaultTheiaSecondaryWindowBounds(): TheiaBrowserWindowOptions {
        // 返回一个空对象，表示没有特定的边界设置
        return {};
    }


    /**
     * 获取默认的 Theia 窗口边界
     * @returns {TheiaBrowserWindowOptions} 默认的窗口边界选项
     */
    protected getDefaultTheiaWindowBounds(): TheiaBrowserWindowOptions {
        // The `screen` API must be required when the application is ready.
        // See: https://electronjs.org/docs/api/screen#screen
        // We must center by hand because `browserWindow.center()` fails on multi-screen setups
        // See: https://github.com/electron/electron/issues/3490
        const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const height = Math.round(bounds.height * (2 / 3));
        const width = Math.round(bounds.width * (2 / 3));
        const y = Math.round(bounds.y + (bounds.height - height) / 2);
        const x = Math.round(bounds.x + (bounds.width - width) / 2);
        return {
            width,
            height,
            x,
            y
        };
    }

    /**
     * Save the window geometry state on every change.
     */
    /**
     * 监听窗口状态变化，延迟保存窗口状态
     * @param electronWindow - 窗口对象
     */
    protected attachSaveWindowState(electronWindow: BrowserWindow): void {
        // 创建一个可销毁的集合，用于管理所有的监听器
        const windowStateListeners = new DisposableCollection();
        // 定义一个延迟保存的超时变量
        let delayedSaveTimeout: NodeJS.Timeout | undefined;
        // 定义一个延迟保存窗口状态的函数
        const saveWindowStateDelayed = () => {
            // 如果已经设置了延迟保存的超时，则清除它
            if (delayedSaveTimeout) {
                clearTimeout(delayedSaveTimeout);
            }
            // 设置一个新的延迟保存超时，1000 毫秒后执行 saveWindowState 方法
            delayedSaveTimeout = setTimeout(() => this.saveWindowState(electronWindow), 1000);
        };
        // 监听窗口的 close 事件，在窗口关闭时立即保存窗口状态
        createDisposableListener(electronWindow, 'close', () => {
            this.saveWindowState(electronWindow);
        }, windowStateListeners);
        // 监听窗口的 resize 事件，在窗口调整大小时延迟保存窗口状态
        createDisposableListener(electronWindow, 'resize', saveWindowStateDelayed, windowStateListeners);
        // 监听窗口的 move 事件，在窗口移动时延迟保存窗口状态
        createDisposableListener(electronWindow, 'move', saveWindowStateDelayed, windowStateListeners);
        // 在窗口关闭时，从 didUseNativeWindowFrameOnStart 集合中删除该窗口的记录
        windowStateListeners.push(Disposable.create(() => { try { this.didUseNativeWindowFrameOnStart.delete(electronWindow.webContents.id); } catch { } }));
        // 将窗口的 useNativeWindowFrame 状态记录到 didUseNativeWindowFrameOnStart 集合中
        this.didUseNativeWindowFrameOnStart.set(electronWindow.webContents.id, this.useNativeWindowFrame);
        // 监听窗口的 closed 事件，在窗口关闭时销毁所有的监听器
        electronWindow.once('closed', () => windowStateListeners.dispose());
    }

    /**
     * 保存窗口状态
     * @param electronWindow - 窗口对象
     */
    protected saveWindowState(electronWindow: BrowserWindow): void {
        // In some circumstances the `electronWindow` can be `null`
        if (!electronWindow) {
            return;
        }
        try {
            const bounds = electronWindow.getBounds();
            const options: TheiaBrowserWindowOptions = {
                isFullScreen: electronWindow.isFullScreen(),
                isMaximized: electronWindow.isMaximized(),
                width: bounds.width,
                height: bounds.height,
                x: bounds.x,
                y: bounds.y,
                frame: this.useNativeWindowFrame,
                screenLayout: this.getCurrentScreenLayout(),
                backgroundColor: this.customBackgroundColor
            };
            this.electronStore.set('windowstate', options);
        } catch (e) {
            console.error('Error while saving window state:', e);
        }
    }


    /**
     * Return a string unique to the current display layout.
     */
    /**
     * 获取当前屏幕的布局信息
     * @returns {string} 屏幕布局信息字符串，格式为 "x1:y1:w1:h1-x2:y2:w2:h2-..."
     */
    protected getCurrentScreenLayout(): string {
        // 使用 screen.getAllDisplays() 获取所有显示器的信息
        return screen.getAllDisplays().map(
            // 对于每个显示器，将其边界信息转换为字符串格式 "x:y:w:h"
            display => `${display.bounds.x}:${display.bounds.y}:${display.bounds.width}:${display.bounds.height}`
            // 对所有显示器的字符串进行排序，并使用 "-" 连接起来
        ).sort().join('-');
    }


    /**
     * Start the NodeJS backend server.
     *
     * @return Running server's port promise.
     */
    /**
    * 启动后端服务器
    * @returns {Promise<number>} 启动后端服务器的端口号
    */
    protected async startBackend(): Promise<number> {
        // 检查是否应该将所有内容作为一个进程运行
        const noBackendFork = process.argv.indexOf('--no-cluster') !== -1;
        // 设置 electron 版本，以便后端进程知道它们正在为 electron 前端提供服务
        process.env.THEIA_ELECTRON_VERSION = process.versions.electron;
        if (noBackendFork) {
            // 如果不使用集群，则将安全令牌传递给后端进程
            process.env[ElectronSecurityToken] = JSON.stringify(this.electronSecurityToken);
            // 动态加载后端服务器的主文件，并期望它导出一个解析为端口号的 Promise
            dynamicRequire(this.globals.THEIA_BACKEND_MAIN_PATH);
            // @ts-expect-error
            const address: AddressInfo = await globalThis.serverAddress;
            return address.port;
        } else {
            // 如果使用集群，则 fork 一个新的后端进程
            const backendProcess = fork(
                this.globals.THEIA_BACKEND_MAIN_PATH,
                this.processArgv.getProcessArgvWithoutBin(),
                await this.getForkOptions(),
            );
            return new Promise((resolve, reject) => {
                // 监听后端进程的消息，以获取服务器端口号
                backendProcess.on('message', (address: AddressInfo) => {
                    resolve(address.port);
                });
                // 监听后端进程的错误事件
                backendProcess.on('error', error => {
                    reject(error);
                });
                // 监听后端进程的退出事件
                backendProcess.on('exit', code => {
                    reject(code);
                });
                // 监听应用程序的退出事件，以便在退出时终止后端进程
                app.on('quit', () => {
                    // 只有在后端进程正在运行时才发送终止信号
                    // eslint-disable-next-line no-null/no-null
                    if (backendProcess.exitCode === null && backendProcess.signalCode === null) {
                        try {
                            // 如果我们为集群 fork 了进程，则需要手动终止它
                            // 参见: https://github.com/eclipse-theia/theia/issues/835
                            if (backendProcess.pid) {
                                process.kill(backendProcess.pid);
                            }
                        } catch (error) {
                            // 参见 https://man7.org/linux/man-pages/man2/kill.2.html#ERRORS
                            if (error.code === 'ESRCH') {
                                return;
                            }
                            throw error;
                        }
                    }
                });
            });
        }
    }


    /**
   * 获取用于 fork 后端进程的选项
   * @returns {Promise<ForkOptions>} 包含 fork 选项的 Promise
   */
    protected async getForkOptions(): Promise<ForkOptions> {
        return {
            // 在 UNIX 上，后端必须是一个进程组的领导者，以便稍后杀死该进程树
            // 参见 https://nodejs.org/api/child_process.html#child_process_options_detached
            detached: process.platform !== 'win32',
            env: {
                // 复制当前进程的环境变量
                ...process.env,
                // 设置 Electron 安全令牌，用于验证后端进程
                [ElectronSecurityToken]: JSON.stringify(this.electronSecurityToken),
            },
        };
    }

    /**
     * 将 Electron 安全令牌附加到指定端口的后端服务器
     * @param port - 后端服务器的端口号
     * @returns {Promise<void>} 操作完成的 Promise
     */
    protected async attachElectronSecurityToken(port: number): Promise<void> {
        // 将安全令牌设置为后端服务器的 cookie
        await this.electronSecurityTokenService.setElectronSecurityTokenCookie(`http://localhost:${port}`);
    }

    /**
     * 挂载应用程序事件处理函数
     */
    protected hookApplicationEvents(): void {
        // 监听应用程序的 will-quit 事件
        app.on('will-quit', this.onWillQuit.bind(this));
        // 监听应用程序的 second-instance 事件
        app.on('second-instance', this.onSecondInstance.bind(this));
        // 监听应用程序的 window-all-closed 事件
        app.on('window-all-closed', this.onWindowAllClosed.bind(this));
        // 监听应用程序的 web-contents-created 事件
        app.on('web-contents-created', this.onWebContentsCreated.bind(this));

        // 在 Windows 上设置默认协议客户端
        if (isWindows) {
            const args = this.processArgv.isBundledElectronApp ? [] : [app.getAppPath()];
            args.push('--open-url');
            app.setAsDefaultProtocolClient(this.config.electron.uriScheme, process.execPath, args);
        } else {
            // 在非 Windows 系统上监听 open-url 事件
            app.on('open-url', (evt, url) => {
                this.openUrl(url);
            });
        }
    }


    /**
   * 处理应用程序即将退出的事件
   * @param event - Electron 事件对象
   */
    protected onWillQuit(event: ElectronEvent): void {
        // 停止所有贡献（可能是插件或其他扩展）
        this.stopContributions();
    }

    /**
     * 处理应用程序的第二个实例启动事件
     * @param event - Electron 事件对象
     * @param argv - 启动参数
     * @param cwd - 当前工作目录
     * @returns {Promise<void>} 处理完成的 Promise
     */
    protected async onSecondInstance(event: ElectronEvent, argv: string[], cwd: string): Promise<void> {
        // 如果启动参数中包含 '--open-url'，则打开指定的 URL
        if (argv.includes('--open-url')) {
            this.openUrl(argv[argv.length - 1]);
        } else {
            // 否则，使用 yargs 解析启动参数，并处理主命令
            createYargs(this.processArgv.getProcessArgvWithoutBin(argv), process.cwd())
                .help(false)
                .command('$0 [file]', false,
                    cmd => cmd
                        .positional('file', { type: 'string' }),
                    async args => {
                        // 处理主命令选项
                        await this.handleMainCommand({
                            file: args.file,
                            cwd: process.cwd(),
                            secondInstance: true
                        });
                    },
                ).parse();
        }
    }


    /**
    * 处理 Web 内容创建事件
    * @param event - Electron 事件对象
    * @param webContents - 创建的 Web 内容对象
    */
    protected onWebContentsCreated(event: ElectronEvent, webContents: WebContents): void {
        // 阻止页面内导航，除非是加载二级窗口内容
        webContents.on('will-navigate', evt => {
            if (new URI(evt.url).path.fsPath() !== new Path(this.globals.THEIA_SECONDARY_WINDOW_HTML_PATH).fsPath()) {
                evt.preventDefault();
            }
        });

        // 设置窗口打开处理器
        webContents.setWindowOpenHandler(details => {
            // 如果是二级窗口，允许打开
            if (new URI(details.url).path.fsPath() === new Path(this.globals.THEIA_SECONDARY_WINDOW_HTML_PATH).fsPath()) {
                const { minWidth, minHeight } = this.getDefaultOptions();
                const options: BrowserWindowConstructorOptions = {
                    ...this.getDefaultTheiaSecondaryWindowBounds(),
                    // 目前我们总是需要原生窗口框架，因为二级窗口默认没有 Theia 的标题栏。
                    // 在“自定义”标题栏模式下，这会使窗口没有任何窗口控件（关闭、最小化、最大化）
                    // TODO 当二级窗口支持自定义标题栏时，设置为 this.useNativeWindowFrame。
                    frame: true,
                    minWidth,
                    minHeight
                };
                if (!this.useNativeWindowFrame) {
                    // 如果主窗口没有原生窗口框架，不要在二级窗口的原生标题栏中显示图标。
                    // 数据 URL 是一个 1x1 透明 png
                    options.icon = nativeImage.createFromDataURL(
                        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12P4DwQACfsD/WMmxY8AAAAASUVORK5CYII=');
                }
                return {
                    action: 'allow',
                    overrideBrowserWindowOptions: options,
                };
            } else {
                const uri: URI = new URI(details.url);
                let okToOpen = uri.scheme === 'https' || uri.scheme === 'http';
                if (!okToOpen) {
                    const button = dialog.showMessageBoxSync(BrowserWindow.fromWebContents(webContents)!, {
                        message: `Open link\n\n${details.url}\n\nin the system handler?`,
                        type: 'question',
                        title: 'Open Link',
                        buttons: ['OK', 'Cancel'],
                        defaultId: 1,
                        cancelId: 1
                    });
                    okToOpen = button === 0;
                }
                if (okToOpen) {
                    shell.openExternal(details.url, {});
                }

                return { action: 'deny' };
            }
        });
    }


    /**
     * 处理窗口全部关闭事件
     * 当所有窗口都关闭时，此方法会被调用。如果应用程序没有设置为重启，它将请求停止应用程序。
     * @param event - Electron 事件对象
     */
    protected onWindowAllClosed(event: ElectronEvent): void {
        // 如果应用程序没有正在重启
        if (!this.restarting) {
            // 请求停止应用程序
            this.requestStop();
        }
    }


    /**
     * 重启应用程序
     * 该方法会尝试关闭当前窗口，并在关闭后重新启动应用程序
     * @param webContents - 重启应用程序的 Web 内容对象
     * @returns {Promise<void>} 操作完成的 Promise
     */
    public async restart(webContents: WebContents): Promise<void> {
        // 设置 restarting 标志为 true，表示应用程序正在重启
        this.restarting = true;
        // 从 windows 映射中获取与 webContents 关联的窗口包装器
        const wrapper = this.windows.get(webContents.id);
        // 如果找到了窗口包装器
        if (wrapper) {
            // 监听窗口的关闭事件
            const listener = wrapper.onDidClose(async () => {
                // 关闭事件处理完成后，注销监听器
                listener.dispose();
                // 调用 handleMainCommand 方法处理主命令选项
                await this.handleMainCommand({
                    // 表示这不是第二个实例
                    secondInstance: false,
                    // 当前工作目录
                    cwd: process.cwd()
                });
                // 重置 restarting 标志为 false，表示重启完成
                this.restarting = false;
            });
            // 如果关闭失败或在此次被取消，不要继续监听它。
            if (!await wrapper.close(StopReason.Restart)) {
                // 如果关闭失败，注销监听器
                listener.dispose();
            }
        }
    }

    /**
     * 启动所有贡献
     * 该方法会遍历所有已注册的贡献，并调用它们的 `onStart` 方法（如果存在）
     * @returns {Promise<void>} 操作完成的 Promise
     */
    protected async startContributions(): Promise<void> {
        // 初始化一个空数组，用于存储所有贡献的启动 Promise
        const promises = [];
        // 遍历所有贡献
        for (const contribution of this.contributions.getContributions()) {
            console.log(`启动的贡献: ${JSON.stringify(contribution)}`);
            // 如果贡献有 onStart 方法，则将其添加到 promises 数组中
            if (contribution.onStart) {
                promises.push(contribution.onStart(this));
            }
        }
        // 等待所有贡献的启动 Promise 全部完成
        await Promise.all(promises);
    }

    /**
     * 停止所有贡献
     * 该方法会遍历所有已注册的贡献，并调用它们的 `onStop` 方法（如果存在）
     */
    protected stopContributions(): void {
        // 遍历所有贡献
        for (const contribution of this.contributions.getContributions()) {
            // 如果贡献有 onStop 方法，则调用它
            if (contribution.onStop) {
                contribution.onStop(this);
            }
        }
    }

}
