import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, X } from 'lucide-react';
import { isCliAgentKind } from '@avorant/shared';
import { useSession } from '../store/sessionStore.js';
import { ActivityDrawer } from '../components/ActivityDrawer.js';
import { Composer } from '../components/Composer.js';
import { MessageTimeline } from '../components/MessageTimeline.js';
import { PresenceStrip } from '../components/PresenceStrip.js';

/** The room (top half of the Mission view): presence strip, live timeline, activity ticker, composer. */
export function RoomView(): JSX.Element {
  const agents = useSession((s) => s.agents);
  const navigate = useNavigate();
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const cliAgents = Object.values(agents).filter((a) => isCliAgentKind(a.kind));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PresenceStrip />

      {cliAgents.length === 1 && !bannerDismissed && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-contract/10 px-3 py-1.5 text-[11.5px] text-contract">
          <span className="min-w-0 truncate">
            The review gate needs a second model — every close requires a peer APPROVE.
          </span>
          <button type="button" onClick={() => navigate('/agents')} className="shrink-0 underline underline-offset-2 hover:text-text">
            Add one
          </button>
          <button
            type="button"
            onClick={() => setBannerDismissed(true)}
            className="ml-auto shrink-0 rounded p-0.5 hover:bg-raised"
            title="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {cliAgents.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Bot className="h-8 w-8 text-dim" />
          <div className="text-sm font-medium">Your agents live here</div>
          <div className="max-w-[400px] text-xs leading-relaxed text-dim">
            Open their terminals below, or run them in your own terminal. Either way, the room holds them.
          </div>
          <button
            type="button"
            onClick={() => navigate('/agents')}
            className="rounded-md border border-border bg-raised px-3 py-1.5 text-xs font-medium hover:border-dim/50"
          >
            Add agents
          </button>
        </div>
      ) : (
        <MessageTimeline />
      )}

      <ActivityDrawer />
      <Composer />
    </div>
  );
}
