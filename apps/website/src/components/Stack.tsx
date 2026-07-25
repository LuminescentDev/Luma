import { Cpu, Layers } from 'lucide-react';

const groups = [
  {
    icon: Cpu,
    label: 'Application',
    items: ['Tauri 2', 'Rust', 'Tokio'],
  },
  {
    icon: Layers,
    label: 'Frontend',
    items: [
      'React 19',
      'TypeScript',
      'Vite',
      'Tailwind CSS',
      'Radix UI',
      'xterm.js',
    ],
  },
];

export function Stack() {
  return (
    <section
      aria-labelledby='stack-heading'
      className='mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28 lg:px-8'
    >
      <div className='max-w-2xl'>
        <p className='text-sm font-semibold uppercase tracking-widest text-accent'>
          Stack
        </p>
        <h2
          id='stack-heading'
          className='mt-3 text-3xl font-bold tracking-tight sm:text-4xl'
        >
          Built on a modern, native foundation
        </h2>
        <p className='mt-4 text-base text-muted sm:text-lg'>
          A Rust backend streams terminal bytes straight to xterm.js through
          Tauri channels — React only ever holds session metadata.
        </p>
      </div>

      <dl className='mt-12 divide-y divide-border/60 sm:mt-16'>
        {groups.map((group) => {
          const Icon = group.icon;
          return (
            <div
              key={group.label}
              className='grid gap-x-10 gap-y-4 py-8 first:pt-0 last:pb-0 md:grid-cols-12'
            >
              <dt className='md:col-span-4'>
                <div className='flex items-center gap-3'>
                  <span className='inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg text-accent filter-[drop-shadow(0_0_16px_rgba(240,204,251,0.45))]'>
                    <Icon className='h-5 w-5' aria-hidden='true' />
                  </span>
                  <span className='text-lg font-semibold tracking-tight'>
                    {group.label}
                  </span>
                </div>
              </dt>
              <dd className='md:col-span-8 md:pt-1'>
                <ul
                  role='list'
                  className='flex flex-wrap items-center gap-x-2 gap-y-2 font-mono text-sm text-foreground/85'
                >
                  {group.items.map((item, index) => (
                    <li key={item} className='flex items-center gap-2'>
                      {index > 0 && (
                        <span
                          aria-hidden='true'
                          className='h-1 w-1 flex-none rounded-full bg-accent/50'
                        />
                      )}
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
