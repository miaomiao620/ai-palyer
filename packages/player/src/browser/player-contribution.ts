import { injectable, inject } from '@theia/core/shared/inversify';
import { MenuModelRegistry } from '@theia/core';
import { AiPlayerWidget } from './player-widget';
import { AbstractViewContribution } from '@theia/core/lib/browser';
import { Command, CommandRegistry } from '@theia/core/lib/common/command';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';

export const AiPlayerCommand: Command = {
    id: 'player.command',
    label: 'Open AI Player'
};

@injectable()
export class AiPlayerContribution extends AbstractViewContribution<AiPlayerWidget> {
    @inject(ApplicationShell)
    protected override readonly shell: ApplicationShell;

    constructor() {
        super({
            widgetId: AiPlayerWidget.ID,
            widgetName: AiPlayerWidget.LABEL,
            defaultWidgetOptions: { area: 'left' },
            toggleCommandId: AiPlayerCommand.id
        });
    }

    public override registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(AiPlayerCommand, {
            execute: () => super.openView({ activate: false, reveal: true })
        });
    }

    public override registerMenus(menus: MenuModelRegistry): void {
        super.registerMenus(menus);
    }
}
