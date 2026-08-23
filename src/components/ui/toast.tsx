'use client';

import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Global shadcn/Base UI toast manager. Use `toast.add()` and `toast.close()`
 * from any client component, matching the shadcn Toast API.
 */
export const toast = ToastPrimitive.createToastManager();

const toastRootClassName = cn(
  "[--gap:0.5rem] [--peek:0.5rem] [--scale:calc(max(0,1-(var(--toast-index)*0.06)))] [--shrink:calc(1-var(--scale))] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)+calc(var(--toast-index)*var(--gap))+var(--toast-swipe-movement-y))] absolute left-0 top-0 z-[calc(1000-var(--toast-index))] w-full origin-top rounded-2xl border border-border/70 bg-background text-foreground shadow-xl after:absolute after:bottom-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-[''] data-[type=error]:border-red-600 data-[type=error]:bg-red-600 data-[type=error]:text-white data-[type=success]:border-emerald-700/30 data-[type=success]:bg-emerald-50 data-[type=success]:text-emerald-950 data-limited:opacity-0 data-starting-style:[transform:translateY(-150%)] data-ending-style:opacity-0 data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))] [&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(-150%)] data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))] data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))] data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))] h-[var(--height)] data-expanded:h-[var(--toast-height)] [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--peek))+(var(--shrink)*var(--height)))_scale(var(--scale))] [transition:transform_0.35s_cubic-bezier(0.22,1,0.36,1),opacity_0.25s,height_0.15s]",
);

function ToastIcon({ type }: { type?: string }) {
  if (type === 'success') return <CheckCircle2 className="size-5 shrink-0 text-emerald-700" />;
  if (type === 'error') return <CircleAlert className="size-5 shrink-0 text-white" />;
  return <Info className="size-5 shrink-0 text-primary" />;
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();

  return toasts.map((item) => (
    <ToastPrimitive.Root key={item.id} toast={item} className={toastRootClassName}>
      <ToastPrimitive.Content className="flex items-start gap-2.5 p-3 pr-10 data-behind:opacity-0 data-expanded:opacity-100">
        <ToastIcon type={item.type} />
        <div className="min-w-0 flex-1 space-y-1">
          {item.title ? <ToastPrimitive.Title className="text-sm font-semibold leading-4" /> : null}
          {item.description ? (
            <ToastPrimitive.Description className="text-xs leading-4 opacity-90" />
          ) : null}
        </div>
        {item.actionProps ? (
          <ToastPrimitive.Action
            className={cn(
              'h-8 shrink-0 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              item.type === 'error' &&
                'border-white/35 bg-transparent text-white hover:bg-white/15',
            )}
          />
        ) : null}
        <ToastPrimitive.Close
          aria-label="Dismiss notification"
          className={cn(
            'absolute right-2.5 top-2.5 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            item.type === 'error' &&
              'text-white/90 hover:bg-white/15 hover:text-white focus-visible:ring-white',
          )}
        >
          <X className="size-4" />
        </ToastPrimitive.Close>
      </ToastPrimitive.Content>
    </ToastPrimitive.Root>
  ));
}

export function Toaster() {
  return (
    <ToastPrimitive.Provider toastManager={toast} limit={5} timeout={5_000}>
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport
          aria-label="Notifications"
          className="fixed left-1/2 top-2.5 z-[100] h-[calc(100vh-2.5rem)] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 outline-none sm:top-4"
        >
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}
