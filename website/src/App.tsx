import { CrossPlatform } from './components/CrossPlatform';
import { Download } from './components/Download';
import { Features } from './components/Features';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { Screenshots } from './components/Screenshots';
import { Stack } from './components/Stack';

export function App() {
  return (
    <>
      <a
        href='#main'
        className='sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-100 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-foreground'
      >
        Skip to content
      </a>
      <Header />
      <main id='main'>
        <Hero />
        <Features />
        <Screenshots />
        <CrossPlatform />
        <Stack />
        <Download />
      </main>
      <Footer />
    </>
  );
}
