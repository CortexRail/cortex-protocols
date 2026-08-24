import { useState, useEffect } from 'react';

export function useSubscriptionNotifications() {
  const [notifications] = useState<unknown[]>([]);
  
  useEffect(() => {
    // SSE connection logic to /api/v1/events/stream
  }, []);

  return { notifications, unreadCount: notifications.length };
}
