import { ContainerModule } from '@theia/core/shared/inversify';
import { AiPlayerWidget } from './ai-player-widget';
import { AiPlayerContribution } from './ai-player-contribution';
import { bindViewContribution, FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';

import '../../src/browser/style/index.css';


export default new ContainerModule(bind => {
    bindViewContribution(bind, AiPlayerContribution);
    bind(FrontendApplicationContribution).toService(AiPlayerContribution);
    bind(AiPlayerWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: AiPlayerWidget.ID,
        createWidget: () => ctx.container.get<AiPlayerWidget>(AiPlayerWidget)
    })).inSingletonScope();
});
