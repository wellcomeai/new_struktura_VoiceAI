import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from './hooks/useAuth';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import ModelsStrip from './components/ModelsStrip';
import HowItWorks from './components/HowItWorks';
import Products from './components/Products';
import Platform from './components/Platform';
import AgentSection from './components/AgentSection';
import Integration from './components/Integration';
import Scenarios from './components/Scenarios';
import TestCall from './components/TestCall';
import Pricing from './components/Pricing';
import Faq from './components/Faq';
import FinalCta from './components/FinalCta';
import Footer from './components/Footer';
import AuthModal from './components/AuthModal';

function App() {
  const [activeTab, setActiveTab] = useState('register');
  const [isModalOpen, setIsModalOpen] = useState(false);

  useAuth();

  const openModal = useCallback((tab) => {
    setActiveTab(tab || 'register');
    setIsModalOpen(true);
  }, []);

  const closeModal = useCallback(() => setIsModalOpen(false), []);

  // Появление блоков при прокрутке
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) e.target.classList.add('on'); }),
      { threshold: 0.08 }
    );
    document.querySelectorAll('.rev').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // Плавная прокрутка по якорям с учётом высоты шапки
  useEffect(() => {
    const onClick = (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      const id = a.getAttribute('href').slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 72;
      window.scrollTo({ top, behavior: 'smooth' });
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
        <ModelsStrip />
        <HowItWorks onOpenModal={openModal} />
        <Products onOpenModal={openModal} />
        <Platform />
        <AgentSection onOpenModal={openModal} />
        <Integration />
        <Scenarios />
        <TestCall />
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
