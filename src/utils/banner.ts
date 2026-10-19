export const renderInitBanner = () => {
  console.log(`SIO NEXUS - ${process.env.SIO_NEXUS_ENV?.toUpperCase() || 'ENV NOT SET'}`);
  console.log('');
};
