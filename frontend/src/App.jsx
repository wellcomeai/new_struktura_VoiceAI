import React, { useState, useCallback } from 'react';
import { useAuth } from './hooks/useAuth';
import useScrollAnimation from './hooks/useScrollAnimation';
import Navbar from './components/Navbar';
import HeroSection from './components/HeroSection';
import ProvidersSection from './components/ProvidersSection';
import WidgetSection from './components/WidgetSection';
import TelephonySection from './components/TelephonySection';
import DialogsSection from './components/DialogsSection';
import CrmSection from './components/CrmSection';
import IntegrationsSection from './components/IntegrationsSection';
import PricingSection from './components/PricingSection';
import Footer from './components/Footer';
import AuthModal from './components/AuthModal';

function App() {
  const [authModal, setAuthModal] = useState({
    isOpen: false,
    activeTab: 'register',
  });

  useAuth();
  useScrollAnimation();

  const openAuthModal = useCallback((tab = 'register') => {
    setAuthModal({ isOpen: true, activeTab: tab });
  }, []);

  const closeAuthModal = useCallback(() => {
    setAuthModal({ isOpen: false, activeTab: 'register' });
  }, []);

  const setActiveTab = useCallback((tab) => {
    setAuthModal((prev) => ({ ...prev, activeTab: tab }));
  }, []);

  return (
    <>
      <Navbar
        onOpenLogin={() => openAuthModal('login')}
        onOpenRegister={() => openAuthModal('register')}
      />

      <main>
        <HeroSection onOpenRegister={() => openAuthModal('register')} />
        <ProvidersSection />
        <WidgetSection />
        <TelephonySection />
        <DialogsSection />
        <CrmSection />
        <IntegrationsSection />
        <PricingSection onOpenRegister={() => openAuthModal('register')} />
      </main>

      <Footer />

      <AuthModal
        isOpen={authModal.isOpen}
        activeTab={authModal.activeTab}
        onTabChange={setActiveTab}
        onClose={closeAuthModal}
      />
    </>
  );
}

export default App;
