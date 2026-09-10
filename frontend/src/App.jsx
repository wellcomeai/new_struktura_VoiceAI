import React, { useState, useEffect, useCallback, useRef } from 'react';
import Lenis from 'lenis';
import { useAuth } from './hooks/useAuth';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import ProductTour from './components/ProductTour';
import AgentSection from './components/AgentSection';
import Start from './components/Start';
import Integration from './components/Integration';
import Scenarios from './components/Scenarios';
import Pricing from './components/Pricing';
import Faq from './components/Faq';
import FinalCta from './components/FinalCta';
import Footer from './components/Footer';
import AuthModal from './components/AuthModal';

function App() {
  const [activeTab, setActiveTab] = useState('register');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const lenisRef = useRef(null);

  useAuth();

  const openModal = useCallback((tab) => {
    setActiveTab(tab || 'register');
    setIsModalOpen(true);
  }, []);

  const closeModal = useCallback(() => setIsModalOpen(false), []);

  // Плавная прокрутка Lenis (выключена при prefers-reduced-motion)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
    lenisRef.current = lenis;
    let raf = 0;
    const loop = (t) => { lenis.raf(t); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); lenis.destroy(); lenisRef.current = null; };
  }, []);

  // Пока открыта модалка, страница под ней не прокручивается
  useEffect(() => {
    const lenis = lenisRef.current;
    if (!lenis) return;
    if (isModalOpen) lenis.stop(); else lenis.start();
  }, [isModalOpen]);

  // Якоря: прокрутка с учётом высоты шапки
  useEffect(() => {
    const onClick = (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      const id = a.getAttribute('href').slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      if (lenisRef.current) {
        lenisRef.current.scrollTo(target, { offset: -72, duration: 1.1 });
      } else {
        const top = target.getBoundingClientRect().top + window.scrollY - 72;
        window.scrollTo({ top, behavior: 'smooth' });
      }
      history.replaceState(null, '', '#' + id);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return (
    <div className="lp">
      <Navbar onOpenModal={openModal} />
      <main>
        <Hero onOpenModal={openModal} />
        <ProductTour />
        <AgentSection onOpenModal={openModal} />
        <Start onOpenModal={openModal} />
        <Integration />
        <Scenarios />
        <Pricing onOpenModal={openModal} />
        <Faq />
        <FinalCta onOpenModal={openModal} />
      </main>
      <Footer />
      <AuthModal
        isOpen={isModalOpen}
        onClose={closeModal}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />
    </div>
  );
}

export default App;
