import * as React from 'react';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { AlertMessage } from '@theia/core/lib/browser/widgets/alert-message';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core';
import { Message } from '@theia/core/lib/browser';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { Widget } from '@theia/core/lib/browser';

import Artplayer from 'artplayer';  // 直接使用默认导入

@injectable()
export class AiPlayerWidget extends ReactWidget {
    static readonly ID = 'player:widget';
    static readonly LABEL = 'AI Player';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    private mainPageWidget: Widget | undefined;
    private art: Artplayer | undefined;

    // 添加类属性来存储状态
    protected videoPath: string = '';
    protected subtitlePath: string = '';

    // 添加更新状态的方法
    protected updateVideoPath = (e: React.ChangeEvent<HTMLInputElement>) => {
        this.videoPath = e.target.value;
        this.update();  // 触发重新渲染
    };

    protected updateSubtitlePath = (e: React.ChangeEvent<HTMLInputElement>) => {
        this.subtitlePath = e.target.value;
        this.update();  // 触发重新渲染
    };

    protected openFilm = () => {
        if (this.art) {
            // 更新视频源
            this.art.url = this.videoPath;
            // 更新字幕
            if (this.subtitlePath) {
                this.art.subtitle.switch(this.subtitlePath);
            }
        }
        console.log('openFilm with:', this.videoPath, this.subtitlePath);
    };

    @postConstruct()
    protected init(): void {
        this.doInit();
    }

    protected async doInit(): Promise<void> {
        this.id = AiPlayerWidget.ID;
        this.title.label = AiPlayerWidget.LABEL;
        this.title.caption = AiPlayerWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'fa fa-film';
        this.update();
    }

    protected createMainPageWidget(): void {
        console.log('Starting createMainPageWidget');
        if (!this.mainPageWidget) {
            console.log('Creating new mainPageWidget');
            this.mainPageWidget = new Widget();
            this.mainPageWidget.id = 'player-main-page';
            this.mainPageWidget.title.label = 'AI Player Page';
            this.mainPageWidget.title.closable = false;

            const element = document.createElement('div');
            // 创建一个div元素作为播放器容器
            const artContainer = document.createElement('div');
            artContainer.id = 'artplayer-container';
            artContainer.style.width = '800px';
            artContainer.style.height = '450px';
            artContainer.style.backgroundColor = '#000';

            element.innerHTML = `
                <div></div>
            `;
            element.appendChild(artContainer);  // 直接添加容器元素
            this.mainPageWidget.node.appendChild(element);
            this.mainPageWidget.node.style.display = 'block';

            this.shell.addWidget(this.mainPageWidget, {
                area: 'main',
                mode: 'split-right'
            });

            setTimeout(() => {
                try {
                    console.log('Initializing Artplayer');
                    // 直接使用创建的div元素
                    this.art = new Artplayer({
                        container: artContainer as HTMLDivElement,  // 类型转换
                        url: 'https://artplayer.org/assets/sample/video.mp4',
                        volume: 0.5,
                        isLive: false,
                        muted: false,
                        autoplay: false,
                        pip: true,
                        autoSize: true,
                        autoMini: true,
                        screenshot: true,
                        setting: true,
                        loop: true,
                        flip: true,
                        playbackRate: true,
                        aspectRatio: true,
                        fullscreen: true,
                        fullscreenWeb: true,
                        subtitleOffset: true,
                        miniProgressBar: true,
                        mutex: true,
                        backdrop: true,
                        playsInline: true,
                        autoPlayback: true,
                        airplay: true
                    });
                    console.log('Artplayer initialized successfully');
                } catch (error) {
                    console.error('Failed to initialize Artplayer:', error);
                }
            }, 100);

            this.mainPageWidget.show();
            this.shell.activateWidget(this.mainPageWidget.id);
            this.shell.revealWidget(this.mainPageWidget.id);
            console.log('Created and showed mainPageWidget');
        } else {
            console.log('mainPageWidget already exists');
        }
    }

    protected render(): React.ReactNode {
        console.log('Rendering AiPlayerWidget');  // 添加日志
        setTimeout(() => {
            console.log('Executing delayed createMainPageWidget');  // 添加日志
            this.createMainPageWidget();
        }, 0);

        return (
            <div id='widget-container' style={{ height: '100%', overflow: 'auto' }}>
                <div style={{ padding: '10px', }}>
                    <h2 style={{ color: 'var(--theia-ui-font-color0)' }}>AI Player Widget</h2>
                    <AlertMessage
                        type='INFO'
                        header='AI Player Widget'
                    />
                    <div style={{ marginBottom: '10px' }}>
                        <div style={{ marginBottom: '5px', color: 'var(--theia-ui-font-color0)' }}>
                            Video Path (.mp4):
                        </div>
                        <input
                            type="text"
                            className="theia-input"
                            value={this.videoPath}
                            onChange={this.updateVideoPath}
                            style={{ width: '100%', marginBottom: '10px' }}
                            placeholder="Enter video path..."
                        />
                        <div style={{ marginBottom: '5px', color: 'var(--theia-ui-font-color0)' }}>
                            Subtitle Path (.srt):
                        </div>
                        <input
                            type="text"
                            className="theia-input"
                            value={this.subtitlePath}
                            onChange={this.updateSubtitlePath}
                            style={{ width: '100%', marginBottom: '10px' }}
                            placeholder="Enter subtitle path..."
                        />
                    </div>
                    <button
                        id='displayMessageButton'
                        className='theia-button secondary'
                        title='Play Video'
                        onClick={this.openFilm}
                        style={{ margin: '10px', display: 'block' }}
                    >
                        Play Video
                    </button>
                </div>
            </div>
        );
    }

    protected override onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        const mainPageWidget = this.shell.widgets.find(w => w.id === 'player-main-page');
        if (mainPageWidget) {
            mainPageWidget.show();
            this.shell.activateWidget(mainPageWidget.id);
            this.shell.revealWidget(mainPageWidget.id);
        }
        console.log('AiPlayerWidget onAfterShow');
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        const htmlElement = document.getElementById('displayMessageButton');
        if (htmlElement) {
            htmlElement.focus();
        }
    }

    protected override onBeforeDetach(msg: Message): void {
        if (this.art) {
            this.art.destroy();
            this.art = undefined;
        }
        super.onBeforeDetach(msg);
    }
} 
