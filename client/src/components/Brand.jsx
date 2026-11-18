// Quayly brand: logo mark + wordmark. Single source for every place the brand appears.
export const PRODUCT = { name: 'Quayly', tagline: 'Every agent, one inbox. Quotes out in minutes.' };

export function LogoMark({ size = 28 }) {
  return <img src="/logo.svg" width={size} height={size} alt="" style={{ display: 'block' }} />;
}

export function Brand({ big }) {
  return (
    <div className={`brand${big ? ' big' : ''}`}>
      <LogoMark size={big ? 36 : 28} />
      <span className="wordmark">{PRODUCT.name}</span>
    </div>
  );
}
