import * as React from 'react';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { AlertMessage } from '@theia/core/lib/browser/widgets/alert-message';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core';
import { Message } from '@theia/core/lib/browser';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { Widget } from '@theia/core/lib/browser';

@injectable()
export class AiPlayerWidget extends ReactWidget {
    static readonly ID = 'player:widget';
    static readonly LABEL = 'AI Player';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    private mainPageWidget: Widget | undefined;

    protected videoPath: string = 'D:\\movie\\Broke_Girls\\Pcjm S01e01.mp4';
    protected subtitlePath: string = 'D:\\movie\\Broke_Girls\\PCJM S01E01.srt';

    protected updateVideoPath = (e: React.ChangeEvent<HTMLInputElement>) => {
        this.videoPath = e.target.value;
        this.update();
    };

    protected updateSubtitlePath = (e: React.ChangeEvent<HTMLInputElement>) => {
        this.subtitlePath = e.target.value;
        this.update();
    };

    protected openFilm = async () => {
        const videoElement = document.querySelector('#player-video') as HTMLVideoElement;
        if (videoElement) {
            videoElement.src = `file://${this.videoPath}`;
            videoElement.muted = false;
            videoElement.volume = 1.0;
            // 如果有字幕路径，添加字幕轨道
            if (this.subtitlePath) {
                // 移除现有字幕轨道
                while (videoElement.firstChild) {
                    videoElement.removeChild(videoElement.firstChild);
                }
                const track = document.createElement('track');
                track.kind = 'subtitles';
                track.src = `file://${this.subtitlePath}`;
                track.srclang = 'en';
                track.label = 'English';
                track.default = true;
                videoElement.appendChild(track);
            }
        }
    };

    @postConstruct()
    protected init(): void {
        this.id = AiPlayerWidget.ID;
        this.title.label = AiPlayerWidget.LABEL;
        this.title.caption = AiPlayerWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'fa fa-film';
        this.update();
    }

    protected createMainPageWidget(): void {
        if (!this.mainPageWidget) {
            this.mainPageWidget = new Widget();
            this.mainPageWidget.id = 'player-main-page';
            this.mainPageWidget.title.label = 'AI Player Page';
            this.mainPageWidget.title.closable = false;

            // 创建外层容器
            const element = document.createElement('div');
            element.style.width = '100%';
            element.style.height = '100%';
            element.style.display = 'flex';
            element.style.flexDirection = 'column';
            element.style.backgroundColor = '#000';

            // 创建视频播放器
            const videoElement = document.createElement('video');
            videoElement.id = 'player-video';
            videoElement.style.width = '100%';
            videoElement.style.height = '100%';
            videoElement.controls = true;
            videoElement.style.outline = 'none';
            videoElement.muted = false;
            videoElement.volume = 1.0;
            videoElement.crossOrigin = 'anonymous';

            element.appendChild(videoElement);
            this.mainPageWidget.node.appendChild(element);

            // 添加到 shell
            this.shell.addWidget(this.mainPageWidget, {
                area: 'main',
                mode: 'split-right'
            });

            // 显示和激活
            this.mainPageWidget.show();
            this.shell.activateWidget(this.mainPageWidget.id);
            this.shell.revealWidget(this.mainPageWidget.id);
        } else {
            this.mainPageWidget.show();
            this.shell.activateWidget(this.mainPageWidget.id);
            this.shell.revealWidget(this.mainPageWidget.id);
        }
    }

    protected render(): React.ReactNode {
        setTimeout(() => {
            this.createMainPageWidget();
        }, 0);

        return (
            <div id='widget-container' style={{ height: '100%', overflow: 'auto' }}>
                <div style={{ padding: '10px' }}>
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
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
    }

    protected override onBeforeDetach(msg: Message): void {
        const videoElement = document.querySelector('#player-video') as HTMLVideoElement;
        if (videoElement) {
            videoElement.pause();
            videoElement.src = '';
        }
        super.onBeforeDetach(msg);
    }
} 
