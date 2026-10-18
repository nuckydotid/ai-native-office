import { Button, Navbar, NavbarBrand, NavbarContent, NavbarItem, Spinner } from '@heroui/react';
import { ProjectShell } from './components/ProjectShell';
import { ThemeSwitch } from './components/ThemeSwitch';
import { DemoStrip } from './demo/DemoStrip';
import { JudgePath } from './demo/JudgePath';
import { useAuth } from './auth';
import { DEMO_PROJECT } from './web';
import icon from './assets/icon.png';

export function App() {
  const { phase, user, error, signIn } = useAuth();

  // Brief moment while the guest is fetched: show nothing rather than flash a screen.
  if (phase === 'loading') return <div className="h-full w-full bg-background" />;
  // No sign-in screen: the guest is taken in automatically; if that fails, say so and try again.
  if (phase !== 'signedIn') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
        {phase === 'signedOut' ? (
          <>
            <p className="max-w-sm text-small text-foreground-500">{error ?? 'The demo couldn’t let you in just now.'}</p>
            <Button color="primary" onPress={() => void signIn()}>
              Try again
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2 text-small text-foreground-500">
            <Spinner size="sm" /> Opening the demo workspace…
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <Navbar maxWidth="full" className="shadow-small" classNames={{ base: 'bg-content1' }}>
        <NavbarBrand className="gap-2">
          <img src={icon} alt="" className="h-6 w-6" />
          <p className="font-semibold">Worktrees Studio</p>
        </NavbarBrand>
        <NavbarContent justify="end">
          <NavbarItem className="hidden sm:flex">
            <span className="max-w-48 truncate text-small text-foreground-500">{user?.name}</span>
          </NavbarItem>
          <NavbarItem>
            <ThemeSwitch />
          </NavbarItem>
        </NavbarContent>
      </Navbar>
      <DemoStrip />
      <ProjectShell project={DEMO_PROJECT} user={user ?? undefined} />
      <JudgePath />
    </div>
  );
}
