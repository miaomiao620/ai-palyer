// *****************************************************************************
// Copyright (C) 2023 STMicroelectronics and others.
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

import {
    ipcMain, BrowserWindow, Menu, MenuItemConstructorOptions, webContents, WebContents, session, shell, clipboard, IpcMainEvent
} from '@theia/electron/shared/electron';
import * as nativeKeymap from '@theia/electron/shared/native-keymap';

import { inject, injectable } from 'inversify';
import { FrontendApplicationState, StopReason } from '../common/frontend-application-state';
import { ElectronSecurityToken } from '../electron-common/electron-token';
import {
    CHANNEL_GET_SECURITY_TOKEN, CHANNEL_SET_MENU, MenuDto, CHANNEL_INVOKE_MENU, CHANNEL_FOCUS_WINDOW,
    CHANNEL_ATTACH_SECURITY_TOKEN, CHANNEL_OPEN_POPUP, CHANNEL_ON_CLOSE_POPUP, CHANNEL_CLOSE_POPUP,
    CHANNEL_GET_TITLE_STYLE_AT_STARTUP,
    CHANNEL_MINIMIZE,
    CHANNEL_MAXIMIZE,
    CHANNEL_UNMAXIMIZE,
    CHANNEL_CLOSE,
    CHANNEL_ON_WINDOW_EVENT,
    WindowEvent,
    CHANNEL_TOGGLE_DEVTOOLS,
    CHANNEL_SET_ZOOM_LEVEL,
    CHANNEL_GET_ZOOM_LEVEL,
    CHANNEL_IS_FULL_SCREENABLE,
    CHANNEL_REQUEST_CLOSE,
    CHANNEL_RESTART,
    CHANNEL_SET_TITLE_STYLE,
    CHANNEL_REQUEST_RELOAD,
    CHANNEL_APP_STATE_CHANGED,
    CHANNEL_SHOW_ITEM_IN_FOLDER,
    CHANNEL_READ_CLIPBOARD,
    CHANNEL_WRITE_CLIPBOARD,
    CHANNEL_IPC_CONNECTION,
    CHANNEL_IS_FULL_SCREEN,
    InternalMenuDto,
    CHANNEL_SET_MENU_BAR_VISIBLE,
    CHANNEL_TOGGLE_FULL_SCREEN,
    CHANNEL_IS_MAXIMIZED,
    CHANNEL_REQUEST_SECONDARY_CLOSE,
    CHANNEL_SET_BACKGROUND_COLOR,
    CHANNEL_WC_METADATA,
    CHANNEL_ABOUT_TO_CLOSE,
    CHANNEL_OPEN_WITH_SYSTEM_APP,
    CHANNEL_OPEN_URL
} from '../electron-common/electron-api';
import { ElectronMainApplication, ElectronMainApplicationContribution } from './electron-main-application';
import { Disposable, DisposableCollection, isOSX, MaybePromise } from '../common';
import { createDisposableListener } from './event-utils';

@injectable()
export class TheiaMainApi implements ElectronMainApplicationContribution {
    /**
     * 注入 ElectronSecurityToken 实例，用于安全相关的操作。
     */
    @inject(ElectronSecurityToken)
    protected electronSecurityToken: ElectronSecurityToken;

    /**
     * 存储打开的弹出窗口的映射，其中键是窗口 ID，值是对应的菜单实例。
     */
    protected readonly openPopups = new Map<number, Menu>();


    onStart(application: ElectronMainApplication): MaybePromise<void> {
        /**
         * 监听 IPC 通道 CHANNEL_WC_METADATA，用于获取窗口元数据
         * 当接收到此通道的消息时，将发送者的 ID 作为字符串返回
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         */
        ipcMain.on(CHANNEL_WC_METADATA, event => {
            // 将发送者的 ID 转换为字符串并返回
            event.returnValue = event.sender.id.toString();
        });


        // electron security token
        /**
         * 监听 IPC 通道 CHANNEL_GET_SECURITY_TOKEN，用于获取安全令牌
         * 当接收到此通道的消息时，将 electronSecurityToken 的值作为字符串返回
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         */
        ipcMain.on(CHANNEL_GET_SECURITY_TOKEN, event => {
            // 将 electronSecurityToken 的值转换为字符串并返回
            event.returnValue = this.electronSecurityToken.value;
        });

        /**
         * 处理 IPC 通道 CHANNEL_ATTACH_SECURITY_TOKEN，用于附加安全令牌到指定的端点
         * 当接收到此通道的消息时，将安全令牌附加到指定的端点
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @param endpoint - 要附加安全令牌的端点
         */
        ipcMain.handle(CHANNEL_ATTACH_SECURITY_TOKEN, (event, endpoint) => session.defaultSession.cookies.set({
            url: endpoint,
            name: ElectronSecurityToken,
            value: JSON.stringify(this.electronSecurityToken),
            httpOnly: true,
            sameSite: 'no_restriction'
        }));


        // application menu
        /**
         * 监听 IPC 通道 CHANNEL_SET_MENU，用于设置应用或窗口的菜单
         * 当接收到此通道的消息时，根据操作系统的不同，设置应用的菜单或特定窗口的菜单
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @param menuId - 菜单的 ID
         * @param menu - 要设置的菜单数据
         */
        ipcMain.on(CHANNEL_SET_MENU, (event, menuId: number, menu: MenuDto[]) => {
            // 根据是否有菜单数据来创建或清除菜单
            let electronMenu: Menu | null;
            if (menu) {
                // 将菜单数据转换为 Electron 的菜单对象
                electronMenu = Menu.buildFromTemplate(this.fromMenuDto(event.sender, menuId, menu));
            } else {
                // 如果没有菜单数据，则清除菜单
                electronMenu = null;
            }

            // 根据操作系统类型设置菜单
            if (isOSX) {
                // 在 macOS 上，设置应用的菜单
                Menu.setApplicationMenu(electronMenu);
            } else {
                // 在其他操作系统上，设置特定窗口的菜单
                BrowserWindow.fromWebContents(event.sender)?.setMenu(electronMenu);
            }

            //bmm打印菜单
            let menuLog = ''
            menu.forEach(itm => {
                menuLog = menuLog + itm.label + '||||';
                itm.submenu?.forEach(sitm => {
                    menuLog += `${sitm.id}&${sitm.label}`;
                });
                console.log(`打印菜单${menuLog}`);
                console.log('--------------------------------------------');
                menuLog = ''
            });


        });
        /**
         * 监听 IPC 通道 CHANNEL_SET_MENU_BAR_VISIBLE，用于设置菜单栏的可见性
         * 当接收到此通道的消息时，根据窗口名称找到对应的窗口，并设置其菜单栏的可见性
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @param visible - 是否显示菜单栏
         * @param windowName - 窗口的名称，如果未指定，则默认为发送者所在的窗口
         */
        ipcMain.on(CHANNEL_SET_MENU_BAR_VISIBLE, (event, visible: boolean, windowName: string | undefined) => {
            // 根据窗口名称查找窗口
            let electronWindow;
            if (windowName) {
                electronWindow = BrowserWindow.getAllWindows().find(win => win.webContents.mainFrame.name === windowName);
            } else {
                electronWindow = BrowserWindow.fromWebContents(event.sender);
            }

            // 如果找到了窗口，则设置菜单栏的可见性
            if (electronWindow) {
                electronWindow.setMenuBarVisibility(visible);
            }
            // 如果没有找到窗口，则打印警告信息
            else {
                console.warn(`There is no known secondary window '${windowName}'. Thus, the menu bar could not be made visible.`);
            }
        });


        // popup menu
        /**
         * 处理 IPC 通道 CHANNEL_OPEN_POPUP，用于打开弹出菜单
         * 当接收到此通道的消息时，根据窗口名称找到对应的窗口，并在指定位置显示弹出菜单
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @param menuId - 菜单的 ID
         * @param menu - 要显示的菜单数据
         * @param x - 弹出菜单的 x 坐标
         * @param y - 弹出菜单的 y 坐标
         * @param windowName - 窗口的名称，如果未指定，则默认为发送者所在的窗口
         */
        ipcMain.handle(CHANNEL_OPEN_POPUP, (event, menuId, menu, x, y, windowName?: string) => {
            // 获取发送者的缩放因子
            const zoom = event.sender.getZoomFactor();
            // TODO: Remove the offset once Electron fixes https://github.com/electron/electron/issues/31641
            // 根据操作系统类型设置偏移量
            const offset = process.platform === 'win32' ? 0 : 2;
            // 将 x 和 y 坐标转换为整数，并根据缩放因子和偏移量进行调整
            x = Math.round(x * zoom) + offset;
            y = Math.round(y * zoom) + offset;
            // 根据菜单数据创建弹出菜单
            const popup = Menu.buildFromTemplate(this.fromMenuDto(event.sender, menuId, menu));
            // 将弹出菜单存储在 openPopups 集合中
            this.openPopups.set(menuId, popup);
            // 根据窗口名称查找窗口
            let electronWindow: BrowserWindow | undefined;
            if (windowName) {
                electronWindow = BrowserWindow.getAllWindows().find(win => win.webContents.mainFrame.name === windowName);
            } else {
                // 如果没有指定窗口名称，则使用发送者所在的窗口
                electronWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
            }
            // 在指定窗口中显示弹出菜单
            popup.popup({
                window: electronWindow,
                // 当弹出菜单关闭时，执行回调函数
                callback: () => {
                    // 从 openPopups 集合中删除弹出菜单
                    this.openPopups.delete(menuId);
                    // 向发送者发送 CHANNEL_ON_CLOSE_POPUP 事件，通知弹出菜单已关闭
                    event.sender.send(CHANNEL_ON_CLOSE_POPUP, menuId);
                }
            });
        });


        /**
         * 处理 IPC 通道 CHANNEL_CLOSE_POPUP，用于关闭弹出菜单
         * 当接收到此通道的消息时，根据菜单的 ID 找到对应的弹出菜单，并关闭它
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @param handle - 要关闭的弹出菜单的 ID
         */
        ipcMain.handle(CHANNEL_CLOSE_POPUP, (event, handle) => {
            // 检查 openPopups 集合中是否存在指定 ID 的弹出菜单
            if (this.openPopups.has(handle)) {
                // 获取指定 ID 的弹出菜单，并调用其 closePopup 方法关闭菜单
                this.openPopups.get(handle)!.closePopup();
            }
        });


        // focus windows for secondary window support
        /**
         * 监听 IPC 通道 CHANNEL_FOCUS_WINDOW，用于聚焦窗口
         * 当接收到此通道的消息时，根据窗口名称找到对应的窗口，并将其聚焦
         * 如果窗口最小化，则会先恢复窗口，然后再聚焦
         * 如果没有找到指定名称的窗口，则会打印警告信息
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @param windowName - 窗口的名称，如果未指定，则默认为发送者所在的窗口
         */
        ipcMain.on(CHANNEL_FOCUS_WINDOW, (event, windowName) => {
            // 根据窗口名称查找窗口
            const electronWindow = windowName
                ? BrowserWindow.getAllWindows().find(win => win.webContents.mainFrame.name === windowName)
                : BrowserWindow.fromWebContents(event.sender);
            // 如果找到了窗口
            if (electronWindow) {
                // 如果窗口最小化，则恢复窗口
                if (electronWindow.isMinimized()) {
                    electronWindow.restore();
                }
                // 聚焦窗口
                electronWindow.focus();
            }
            // 如果没有找到窗口，则打印警告信息
            else {
                console.warn(`There is no known secondary window '${windowName}'. Thus, the window could not be focussed.`);
            }
        });


        /**
    * 监听 IPC 通道 CHANNEL_SHOW_ITEM_IN_FOLDER，用于在文件管理器中显示文件或文件夹
    * 当接收到此通道的消息时，使用 shell 模块的 showItemInFolder 方法显示指定的文件路径
    * 
    * @param event - IpcMainEvent 对象，包含了发送者的信息
    * @param fsPath - 要显示的文件或文件夹的路径
    */
        ipcMain.on(CHANNEL_SHOW_ITEM_IN_FOLDER, (event, fsPath) => {
            shell.showItemInFolder(fsPath);
        });

        /**
         * 监听 IPC 通道 CHANNEL_OPEN_WITH_SYSTEM_APP，用于使用系统默认应用打开文件或链接
         * 当接收到此通道的消息时，使用 shell 模块的 openExternal 方法打开指定的 URI
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @param uri - 要打开的文件或链接的 URI
         */
        ipcMain.on(CHANNEL_OPEN_WITH_SYSTEM_APP, (event, uri) => {
            shell.openExternal(uri);
        });

        /**
         * 处理 IPC 通道 CHANNEL_GET_TITLE_STYLE_AT_STARTUP，用于获取应用启动时的标题栏样式
         * 当接收到此通道的消息时，调用 application 模块的 getTitleBarStyleAtStartup 方法获取样式，并返回给发送者
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @returns 应用启动时的标题栏样式
         */
        ipcMain.handle(CHANNEL_GET_TITLE_STYLE_AT_STARTUP, event => application.getTitleBarStyleAtStartup(event.sender));

        /**
         * 监听 IPC 通道 CHANNEL_SET_TITLE_STYLE，用于设置应用的标题栏样式
         * 当接收到此通道的消息时，调用 application 模块的 setTitleBarStyle 方法设置样式
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @param style - 要设置的标题栏样式
         */
        ipcMain.on(CHANNEL_SET_TITLE_STYLE, (event, style) => application.setTitleBarStyle(event.sender, style));

        /**
         * 监听 IPC 通道 CHANNEL_SET_BACKGROUND_COLOR，用于设置应用的背景颜色
         * 当接收到此通道的消息时，调用 application 模块的 setBackgroundColor 方法设置背景颜色
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @param backgroundColor - 要设置的背景颜色
         */
        ipcMain.on(CHANNEL_SET_BACKGROUND_COLOR, (event, backgroundColor) => application.setBackgroundColor(event.sender, backgroundColor));

        /**
         * 监听 IPC 通道 CHANNEL_MINIMIZE，用于最小化窗口
         * 当接收到此通道的消息时，调用 BrowserWindow 模块的 minimize 方法最小化指定的窗口
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         */
        ipcMain.on(CHANNEL_MINIMIZE, event => {
            BrowserWindow.fromWebContents(event.sender)?.minimize();
        });

        /**
         * 监听 IPC 通道 CHANNEL_IS_MAXIMIZED，用于检查窗口是否最大化
         * 当接收到此通道的消息时，调用 BrowserWindow 模块的 isMaximized 方法检查指定的窗口是否最大化，并将结果返回给发送者
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @returns 指定窗口是否最大化的布尔值
         */
        ipcMain.on(CHANNEL_IS_MAXIMIZED, event => {
            event.returnValue = BrowserWindow.fromWebContents(event.sender)?.isMaximized();
        });

        /**
         * 监听 IPC 通道 CHANNEL_MAXIMIZE，用于最大化窗口
         * 当接收到此通道的消息时，调用 BrowserWindow 模块的 maximize 方法最大化指定的窗口
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         */
        ipcMain.on(CHANNEL_MAXIMIZE, event => {
            BrowserWindow.fromWebContents(event.sender)?.maximize();
        });

        /**
         * 监听 IPC 通道 CHANNEL_UNMAXIMIZE，用于取消窗口最大化
         * 当接收到此通道的消息时，调用 BrowserWindow 模块的 unmaximize 方法取消指定窗口的最大化状态
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         */
        ipcMain.on(CHANNEL_UNMAXIMIZE, event => {
            BrowserWindow.fromWebContents(event.sender)?.unmaximize();
        });

        /**
         * 监听 IPC 通道 CHANNEL_CLOSE，用于关闭窗口
         * 当接收到此通道的消息时，调用 BrowserWindow 模块的 close 方法关闭指定的窗口
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         */
        ipcMain.on(CHANNEL_CLOSE, event => {
            BrowserWindow.fromWebContents(event.sender)?.close();
        });

        /**
         * 监听 IPC 通道 CHANNEL_RESTART，用于重启应用
         * 当接收到此通道的消息时，调用 application 模块的 restart 方法重启应用
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         */
        ipcMain.on(CHANNEL_RESTART, event => {
            application.restart(event.sender);
        });

        /**
         * 监听 IPC 通道 CHANNEL_TOGGLE_DEVTOOLS，用于切换开发者工具
         * 当接收到此通道的消息时，调用 WebContents 模块的 toggleDevTools 方法切换指定窗口的开发者工具
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         */
        ipcMain.on(CHANNEL_TOGGLE_DEVTOOLS, event => {
            event.sender.toggleDevTools();
        });

        /**
         * 监听 IPC 通道 CHANNEL_SET_ZOOM_LEVEL，用于设置窗口的缩放级别
         * 当接收到此通道的消息时，调用 WebContents 模块的 setZoomLevel 方法设置指定窗口的缩放级别
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @param zoomLevel - 要设置的缩放级别
         */
        ipcMain.on(CHANNEL_SET_ZOOM_LEVEL, (event, zoomLevel: number) => {
            event.sender.setZoomLevel(zoomLevel);
        });

        /**
         * 处理 IPC 通道 CHANNEL_GET_ZOOM_LEVEL，用于获取窗口的缩放级别
         * 当接收到此通道的消息时，调用 WebContents 模块的 getZoomLevel 方法获取指定窗口的缩放级别，并返回给发送者
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @returns 指定窗口的缩放级别
         */
        ipcMain.handle(CHANNEL_GET_ZOOM_LEVEL, event => event.sender.getZoomLevel());


        /**
   * 监听 IPC 通道 CHANNEL_TOGGLE_FULL_SCREEN，用于切换窗口的全屏状态
   * 当接收到此通道的消息时，调用 BrowserWindow 模块的 setFullScreen 方法设置指定窗口的全屏状态
   * 
   * @param event - IpcMainEvent 对象，包含了发送者的信息
   */
        ipcMain.on(CHANNEL_TOGGLE_FULL_SCREEN, event => {
            const win = BrowserWindow.fromWebContents(event.sender);
            if (win) {
                win.setFullScreen(!win.isFullScreen());
            }
        });

        /**
         * 监听 IPC 通道 CHANNEL_IS_FULL_SCREENABLE，用于检查窗口是否可以全屏
         * 当接收到此通道的消息时，调用 BrowserWindow 模块的 isFullScreenable 方法检查指定的窗口是否可以全屏，并将结果返回给发送者
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @returns 指定窗口是否可以全屏的布尔值
         */
        ipcMain.on(CHANNEL_IS_FULL_SCREENABLE, event => {
            event.returnValue = BrowserWindow.fromWebContents(event.sender)?.isFullScreenable();
        });

        /**
         * 监听 IPC 通道 CHANNEL_IS_FULL_SCREEN，用于检查窗口是否全屏
         * 当接收到此通道的消息时，调用 BrowserWindow 模块的 isFullScreen 方法检查指定的窗口是否全屏，并将结果返回给发送者
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @returns 指定窗口是否全屏的布尔值
         */
        ipcMain.on(CHANNEL_IS_FULL_SCREEN, event => {
            event.returnValue = BrowserWindow.fromWebContents(event.sender)?.isFullScreen();
        });

        /**
         * 监听 IPC 通道 CHANNEL_READ_CLIPBOARD，用于读取剪贴板内容
         * 当接收到此通道的消息时，调用 clipboard 模块的 readText 方法读取剪贴板内容，并将结果返回给发送者
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @returns 剪贴板内容
         */
        ipcMain.on(CHANNEL_READ_CLIPBOARD, event => {
            event.returnValue = clipboard.readText();
        });

        /**
         * 监听 IPC 通道 CHANNEL_WRITE_CLIPBOARD，用于写入剪贴板内容
         * 当接收到此通道的消息时，调用 clipboard 模块的 writeText 方法写入指定的文本到剪贴板
         * 
         * @param event - IpcMainEvent 对象，包含了发送者的信息
         * @param text - 要写入剪贴板的文本
         */
        ipcMain.on(CHANNEL_WRITE_CLIPBOARD, (event, text) => {
            clipboard.writeText(text);
        });

        /**
         * 监听键盘布局变化事件，当键盘布局发生变化时，通知所有 WebContents
         * 
         * @param newLayout - 新的键盘布局信息，包括布局名称和键位映射
         */
        nativeKeymap.onDidChangeKeyboardLayout(() => {
            const newLayout = {
                info: nativeKeymap.getCurrentKeyboardLayout(),
                mapping: nativeKeymap.getKeyMap()
            };
            for (const webContent of webContents.getAllWebContents()) {
                webContent.send('keyboardLayoutChanged', newLayout);
            }
        });

    }

    /**
    * 检查给定的字符串是否只包含 ASCII 字符。
    * 
    * @param accelerator - 要检查的字符串。
    * @returns 如果字符串只包含 ASCII 字符，则返回 true，否则返回 false。
    */
    private isASCI(accelerator: string | undefined): boolean {
        // 如果 accelerator 不是字符串类型，则返回 false
        if (typeof accelerator !== 'string') {
            return false;
        }
        // 遍历字符串中的每个字符
        for (let i = 0; i < accelerator.length; i++) {
            // 如果字符的 Unicode 码点大于 127，则返回 false
            if (accelerator.charCodeAt(i) > 127) {
                return false;
            }
        }
        // 如果字符串中的所有字符都是 ASCII 字符，则返回 true
        return true;
    }

    /**
     * 将一个菜单数据对象转换为 Electron 菜单的构造选项数组。
     * 
     * @param sender - 发送菜单数据的 WebContents 对象。
     * @param menuId - 菜单的 ID。
     * @param menuDto - 要转换的菜单数据对象。
     * @returns 一个包含 Electron 菜单构造选项的数组。
     */
    fromMenuDto(sender: WebContents, menuId: number, menuDto: InternalMenuDto[]): MenuItemConstructorOptions[] {
        // 将 menuDto 数组转换为 MenuItemConstructorOptions 数组
        return menuDto.map(dto => {
            // 创建一个新的 MenuItemConstructorOptions 对象
            const result: MenuItemConstructorOptions = {
                // 设置菜单项的 ID
                id: dto.id,
                // 设置菜单项的标签
                label: dto.label,
                // 设置菜单项的类型
                type: dto.type,
                // 设置菜单项是否被选中
                checked: dto.checked,
                // 设置菜单项是否可用
                enabled: dto.enabled,
                // 设置菜单项是否可见
                visible: dto.visible,
                // 设置菜单项的角色
                role: dto.role,
                // 如果 accelerator 是 ASCII 字符串，则设置菜单项的快捷键
                accelerator: this.isASCI(dto.accelerator) ? dto.accelerator : undefined
            };
            // 如果菜单项有子菜单，则递归调用 fromMenuDto 方法
            if (dto.submenu) {
                result.submenu = this.fromMenuDto(sender, menuId, dto.submenu);
            }
            // 如果菜单项有处理程序 ID，则设置点击事件处理程序
            if (dto.handlerId) {
                result.click = () => {
                    // 当菜单项被点击时，发送一个 IPC 消息来调用处理程序
                    sender.send(CHANNEL_INVOKE_MENU, menuId, dto.handlerId);
                };
            }
            // 返回转换后的菜单项构造选项
            return result;
        });
    }

}

/**
 * 存储下一个回复通道的编号。
 * 每当有新的回复通道请求时，这个编号会自增。
 */
let nextReplyChannel: number = 0;


export namespace TheiaRendererAPI {
    /**
     * 向指定的 WebContents 发送窗口事件。
     * 
     * @param wc - 目标 WebContents。
     * @param event - 要发送的窗口事件。
     */
    export function sendWindowEvent(wc: WebContents, event: WindowEvent): void {
        // 使用 CHANNEL_ON_WINDOW_EVENT 通道发送事件
        wc.send(CHANNEL_ON_WINDOW_EVENT, event);
    }

    /**
     * 在 Electron 应用中打开一个 URL，并返回一个 Promise，该 Promise 在 URL 打开成功或失败时解决。
     * 
     * @param wc - 目标 WebContents。
     * @param url - 要打开的 URL。
     * @returns 一个 Promise，当 URL 打开成功时解决为 true，否则解决为 false。
     */
    export function openUrl(wc: WebContents, url: string): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            // 生成一个唯一的回复通道编号
            const channelNr = nextReplyChannel++;
            // 创建一个基于编号的回复通道名称
            const replyChannel = `openUrl${channelNr}`;

            // 创建一个一次性监听器，用于处理来自渲染器进程的回复
            const l = createDisposableListener(ipcMain, replyChannel, (e, args: any[]) => {
                // 当接收到回复时，清理监听器并解析 Promise
                l.dispose();
                resolve(args[0]);
            });

            // 使用 CHANNEL_OPEN_URL 通道发送 URL 和回复通道
            wc.send(CHANNEL_OPEN_URL, url, replyChannel);
        });
    }
    /**
     * 向指定的 WebContents 发送窗口即将关闭的事件，并等待确认。
     * 
     * @param wc - 目标 WebContents。
     * @returns 一个 Promise，当窗口即将关闭的事件被确认时解决。
     */
    export function sendAboutToClose(wc: WebContents): Promise<void> {
        return new Promise<void>(resolve => {
            const channelNr = nextReplyChannel++;
            const replyChannel = `aboutToClose${channelNr}`;
            const l = createDisposableListener(ipcMain, replyChannel, e => {
                l.dispose();
                resolve();
            });

            wc.send(CHANNEL_ABOUT_TO_CLOSE, replyChannel);
        });
    }

    /**
     * 请求关闭窗口，并根据用户的选择返回一个 Promise，表示窗口是否关闭。
     * 
     * @param wc - 目标 WebContents。
     * @param stopReason - 关闭窗口的原因。
     * @returns 一个 Promise，当窗口关闭的请求被确认时解决为 true，否则解决为 false。
     */
    export function requestClose(wc: WebContents, stopReason: StopReason): Promise<boolean> {
        const channelNr = nextReplyChannel++;
        const confirmChannel = `confirm-${channelNr}`;
        const cancelChannel = `cancel-${channelNr}`;
        const disposables = new DisposableCollection();

        return new Promise<boolean>(resolve => {
            wc.send(CHANNEL_REQUEST_CLOSE, stopReason, confirmChannel, cancelChannel);
            createDisposableListener(ipcMain, confirmChannel, e => {
                resolve(true);
            }, disposables);
            createDisposableListener(ipcMain, cancelChannel, e => {
                resolve(false);
            }, disposables);
        }).finally(() => disposables.dispose());
    }

    /**
     * 请求关闭辅助窗口，并根据用户的选择返回一个 Promise，表示辅助窗口是否关闭。
     * 
     * @param mainWindow - 主窗口的 WebContents。
     * @param secondaryWindow - 辅助窗口的 WebContents。
     * @returns 一个 Promise，当辅助窗口关闭的请求被确认时解决为 true，否则解决为 false。
     */
    export function requestSecondaryClose(mainWindow: WebContents, secondaryWindow: WebContents): Promise<boolean> {
        const channelNr = nextReplyChannel++;
        const confirmChannel = `confirm-${channelNr}`;
        const cancelChannel = `cancel-${channelNr}`;
        const disposables = new DisposableCollection();

        return new Promise<boolean>(resolve => {
            mainWindow.send(CHANNEL_REQUEST_SECONDARY_CLOSE, secondaryWindow.mainFrame.name, confirmChannel, cancelChannel);
            createDisposableListener(ipcMain, confirmChannel, e => {
                resolve(true);
            }, disposables);
            createDisposableListener(ipcMain, cancelChannel, e => {
                resolve(false);
            }, disposables);
        }).finally(() => disposables.dispose());
    }

    /**
     * 当接收到重新加载请求时调用指定的处理函数。
     * 
     * @param wc - 目标 WebContents。
     * @param handler - 当接收到重新加载请求时调用的处理函数。
     * @returns 一个 Disposable 对象，用于取消监听器。
     */
    export function onRequestReload(wc: WebContents, handler: () => void): Disposable {
        return createWindowListener(wc, CHANNEL_REQUEST_RELOAD, handler);
    }

    /**
     * 当应用程序状态改变时调用指定的处理函数。
     * 
     * @param wc - 目标 WebContents。
     * @param handler - 当应用程序状态改变时调用的处理函数。
     * @returns 一个 Disposable 对象，用于取消监听器。
     */
    export function onApplicationStateChanged(wc: WebContents, handler: (state: FrontendApplicationState) => void): Disposable {
        return createWindowListener(wc, CHANNEL_APP_STATE_CHANGED, state => handler(state as FrontendApplicationState));
    }

    /**
     * 当接收到 IPC 数据时调用指定的处理函数。
     * 
     * @param handler - 当接收到 IPC 数据时调用的处理函数。
     * @returns 一个 Disposable 对象，用于取消监听器。
     */
    export function onIpcData(handler: (sender: WebContents, data: Uint8Array) => void): Disposable {
        return createDisposableListener<IpcMainEvent>(ipcMain, CHANNEL_IPC_CONNECTION, (event, data) => handler(event.sender, data as Uint8Array));
    }

    /**
     * 向指定的 WebContents 发送数据。
     * 
     * @param wc - 目标 WebContents。
     * @param data - 要发送的数据。
     */
    export function sendData(wc: WebContents, data: Uint8Array): void {
        wc.send(CHANNEL_IPC_CONNECTION, data);
    }

    /**
     * 创建一个监听器，当接收到指定通道的消息时，只在消息发送者是指定的 WebContents 时调用处理函数。
     * 
     * @param wc - 目标 WebContents。
     * @param channel - 要监听的通道。
     * @param handler - 当接收到消息时调用的处理函数。
     * @returns 一个 Disposable 对象，用于取消监听器。
     */
    function createWindowListener(wc: WebContents, channel: string, handler: (...args: unknown[]) => unknown): Disposable {
        return createDisposableListener<IpcMainEvent>(ipcMain, channel, (event, ...args) => {
            if (wc.id === event.sender.id) {
                handler(...args);
            }
        });
    }

}
