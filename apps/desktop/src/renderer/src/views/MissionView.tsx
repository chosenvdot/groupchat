import type { JSX } from 'react';
import { PaneDeck } from '../components/PaneDeck.js';
import { RoomView } from './RoomView.js';

/**
 * The terminal-first main screen: the room (presence, timeline, composer) on
 * top, the embedded agent terminal deck below — the 4-way mission view.
 */
export function MissionView(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[40%] min-w-0 flex-1 flex-col overflow-hidden">
        <RoomView />
      </div>
      <PaneDeck />
    </div>
  );
}
