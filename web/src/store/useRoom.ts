// Room mode as a React hook: watch room `code` for as long as the component
// is mounted, in place of useSimEngine. With `?mockroom` in the address it
// watches the stand-in room instead (store/roomMock.ts).

import { useEffect } from 'react';
import { openRoom } from './room';
import { mockRoom, mockRoomWanted } from './roomMock';

export function useRoom(code: string | null): void {
  useEffect(() => {
    if (code === null || code === '') return;
    return mockRoomWanted() ? openRoom(code, mockRoom(code)) : openRoom(code);
  }, [code]);
}
