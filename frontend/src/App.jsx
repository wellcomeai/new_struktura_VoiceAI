import React, { useState, useEffect } from 'react';
import { useAuth } from './hooks/useAuth';
import MeshBackground from './components/MeshBackground';
import Navbar from './components/Navbar';
import HeroSection from './components/HeroSection';
import CodeSection from './components/CodeSection';
import ShowcaseSection from './components/ShowcaseSection';
import PhoneCTASection from './components/PhoneCTASection';
import ProvidersSection from './components/ProvidersSection';
import PricingSection from './components/PricingSection';
import AuthSection from './components/AuthSection/AuthSection';
import Footer from './components/Footer';

function App() {
  const [activeTab, setActiveTab] = useState('register');

  useAuth();

  // IntersectionObserver for .rev elements
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('on');
          }
        });
      },
      { threshold: 0.08 }
    );

    document.querySelectorAll('.rev').forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, []);

  // Smooth scroll for anchor links
  useEffect(() => {
    const handleClick = (e) => {
      const href = e.currentTarget.getAttribute('href');
      if (href && href.startsWith('#')) {
        const target = document.querySelector(href);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    };

    const links = document.querySelectorAll('a[href^="#"]');
    links.forEach((link) => link.addEventListener('click', handleClick));

    return () => {
      links.forEach((link) => link.removeEventListener('click', handleClick));
    };
  }, []);

  return (
    <>
      <MeshBackground />
      <Navbar />
      <HeroSection />
      <CodeSection />
      <ShowcaseSection />
      <PhoneCTASection />
      <ProvidersSection />
      <PricingSection />
      <AuthSection activeTab={activeTab} setActiveTab={setActiveTab} />
      <Footer />
    </>
  );
}

export default App;
